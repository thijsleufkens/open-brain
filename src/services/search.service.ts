/**
 * SearchService — hybrid semantic + keyword search with Reciprocal Rank Fusion.
 *
 * Search pipeline:
 * 1. Embed query with RETRIEVAL_QUERY task type
 * 2. Vector k-NN via sqlite-vec (semantic similarity)
 * 3. FTS5 MATCH (exact keyword matching)
 * 4. Reciprocal Rank Fusion (k=60) to combine both result sets
 * 5. Apply metadata filters (topic, person, source, noteType, date range)
 * 6. Fetch full thought objects for top-N results
 */
import type Database from "better-sqlite3";
import { ok, err, Result } from "neverthrow";
import type { ThoughtRepository } from "../repositories/thought.repository.js";
import type { EmbeddingRepository } from "../repositories/embedding.repository.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";
import type { EmbeddingProvider } from "../types/embedding.js";
import type { Thought, SearchResult, SearchInput } from "../types/thought.js";
import { searchInputSchema } from "../types/thought.js";
import { AppError, ValidationError } from "../types/errors.js";
import type { Logger } from "../utils/logger.js";

// Reciprocal Rank Fusion constant
const RRF_K = 60;

export class SearchService {
  constructor(
    private readonly db: Database.Database,
    private readonly thoughtRepo: ThoughtRepository,
    private readonly embeddingRepo: EmbeddingRepository,
    private readonly metadataRepo: MetadataRepository,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly logger: Logger
  ) {}

  async search(input: unknown): Promise<Result<SearchResult[], AppError>> {
    const parsed = searchInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        new ValidationError(
          `Invalid search input: ${parsed.error.issues.map((i) => i.message).join(", ")}`
        )
      );
    }

    const { query, limit, source, noteType, topic, person, dateFrom, dateTo } =
      parsed.data;

    this.logger.info({ query, limit, filters: { source, noteType, topic, person } }, "Searching");

    // Step 1: Vector search
    let vecResults: Map<string, number> = new Map();
    try {
      const queryEmbedding = await this.embeddingProvider.embed(query, "query");
      const vecSearchResult = this.embeddingRepo.searchSimilar(
        queryEmbedding,
        limit * 3 // fetch more for fusion
      );
      if (vecSearchResult.isOk()) {
        vecSearchResult.value.forEach((r, rank) => {
          vecResults.set(r.thoughtId, rank);
        });
      }
    } catch (error) {
      this.logger.warn({ error }, "Vector search failed, falling back to FTS only");
    }

    // Step 2: Full-text search
    const ftsResults: Map<string, number> = new Map();
    try {
      const ftsRows = this.db
        .prepare(
          `SELECT t.id, rank
           FROM thoughts_fts fts
           JOIN thoughts t ON t.rowid = fts.rowid
           WHERE thoughts_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(this.escapeFtsQuery(query), limit * 3) as {
        id: string;
        rank: number;
      }[];
      ftsRows.forEach((r, rank) => {
        ftsResults.set(r.id, rank);
      });
    } catch (error) {
      this.logger.warn({ error }, "FTS search failed, using vector results only");
    }

    // Step 3: Reciprocal Rank Fusion
    const allIds = new Set([...vecResults.keys(), ...ftsResults.keys()]);
    const scored: { id: string; score: number; matchType: "vector" | "fts" | "both" }[] = [];

    for (const id of allIds) {
      const vecRank = vecResults.get(id);
      const ftsRank = ftsResults.get(id);

      let score = 0;
      let matchType: "vector" | "fts" | "both";

      if (vecRank !== undefined) score += 1 / (RRF_K + vecRank);
      if (ftsRank !== undefined) score += 1 / (RRF_K + ftsRank);

      if (vecRank !== undefined && ftsRank !== undefined) matchType = "both";
      else if (vecRank !== undefined) matchType = "vector";
      else matchType = "fts";

      scored.push({ id, score, matchType });
    }

    scored.sort((a, b) => b.score - a.score);

    // Step 4: Apply filters
    let candidateIds = scored.map((s) => s.id);

    // Topic filter
    if (topic) {
      const topicResult = this.metadataRepo.findThoughtIdsByTopic(topic);
      if (topicResult.isOk()) {
        const topicIds = new Set(topicResult.value);
        candidateIds = candidateIds.filter((id) => topicIds.has(id));
      }
    }

    // Person filter
    if (person) {
      const personResult = this.metadataRepo.findThoughtIdsByPerson(person);
      if (personResult.isOk()) {
        const personIds = new Set(personResult.value);
        candidateIds = candidateIds.filter((id) => personIds.has(id));
      }
    }

    // Take top N after filters
    candidateIds = candidateIds.slice(0, limit);

    // Step 5: Fetch full thoughts
    const thoughtsResult = this.thoughtRepo.findByIds(candidateIds);
    if (thoughtsResult.isErr()) return err(thoughtsResult.error);

    const thoughtMap = new Map(
      thoughtsResult.value.map((t) => [t.id, t])
    );

    // Step 6: Apply remaining filters and build results
    const results: SearchResult[] = [];
    for (const s of scored) {
      if (!candidateIds.includes(s.id)) continue;
      const thought = thoughtMap.get(s.id);
      if (!thought) continue;

      // Source filter
      if (source && thought.source !== source) continue;
      // NoteType filter
      if (noteType && thought.noteType !== noteType) continue;
      // Date filters
      if (dateFrom && thought.createdAt < dateFrom) continue;
      if (dateTo && thought.createdAt > dateTo) continue;

      results.push({
        thought,
        score: s.score,
        matchType: s.matchType,
      });

      if (results.length >= limit) break;
    }

    this.logger.info(
      { query, resultCount: results.length, vecCount: vecResults.size, ftsCount: ftsResults.size },
      "Search completed"
    );

    return ok(results);
  }

  private escapeFtsQuery(query: string): string {
    // FTS5 query: wrap each word in quotes to avoid syntax errors with special chars
    return query
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(" ");
  }
}
