/**
 * ThoughtService — core capture pipeline for Open Brain.
 *
 * Handles the complete lifecycle of a thought:
 * 1. Validate input via Zod schema
 * 2. Check for duplicates (cosine similarity > threshold)
 * 3. Generate embedding via EmbeddingProvider
 * 4. Persist thought + vector in SQLite
 *
 * Metadata extraction happens asynchronously via ExtractionWorker.
 */
import { ok, err, Result } from "neverthrow";
import type { ThoughtRepository } from "../repositories/thought.repository.js";
import type { EmbeddingRepository } from "../repositories/embedding.repository.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";
import type { EmbeddingProvider } from "../types/embedding.js";
import type { Thought, CaptureInput } from "../types/thought.js";
import { captureInputSchema } from "../types/thought.js";
import { AppError, ValidationError } from "../types/errors.js";
import type { Logger } from "../utils/logger.js";

/** Cosine distance threshold for duplicate detection (sqlite-vec uses L2 distance on normalized vectors) */
const DUPLICATE_DISTANCE_THRESHOLD = 0.10; // ~cosine similarity 0.95

export interface DuplicateInfo {
  isDuplicate: boolean;
  existingThought?: Thought;
  distance?: number;
}

export class ThoughtService {
  constructor(
    private readonly thoughtRepo: ThoughtRepository,
    private readonly embeddingRepo: EmbeddingRepository,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly logger: Logger,
    private readonly metadataRepo?: MetadataRepository
  ) {}

  /**
   * Capture a new thought: validate → embed → dedup check → store.
   * Returns the saved thought or a validation/embedding error.
   */
  async capture(input: unknown): Promise<Result<Thought, AppError>> {
    // Validate input
    const parsed = captureInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        new ValidationError(
          `Invalid input: ${parsed.error.issues.map((i) => i.message).join(", ")}`
        )
      );
    }

    const { content, noteType, source } = parsed.data;
    const resolvedNoteType = noteType ?? "idea";

    this.logger.info(
      { source, noteType: resolvedNoteType, contentLength: content.length },
      "Capturing thought"
    );

    // Generate embedding
    let embedding: Float32Array;
    try {
      embedding = await this.embeddingProvider.embed(content, "document");
    } catch (error) {
      return err(
        new AppError(
          `Embedding failed: ${error instanceof Error ? error.message : String(error)}`,
          "EMBEDDING_ERROR",
          error
        )
      );
    }

    // Duplicate detection — check if very similar thought already exists
    const dupCheck = this.checkDuplicate(embedding);
    if (dupCheck.isDuplicate && dupCheck.existingThought) {
      this.logger.info(
        {
          existingId: dupCheck.existingThought.id,
          distance: dupCheck.distance,
        },
        "Duplicate thought detected, skipping capture"
      );
      return err(
        new ValidationError(
          `Duplicate detected: very similar thought already exists (id: ${dupCheck.existingThought.id})`
        )
      );
    }

    // Insert thought
    const thoughtResult = this.thoughtRepo.insert(
      content,
      source,
      resolvedNoteType,
      this.embeddingProvider.modelName,
      this.embeddingProvider.dimensions
    );
    if (thoughtResult.isErr()) return err(thoughtResult.error);
    const thought = thoughtResult.value;

    // Insert embedding
    const embResult = this.embeddingRepo.insert(thought.id, embedding);
    if (embResult.isErr()) {
      this.logger.error(
        { thoughtId: thought.id, error: embResult.error },
        "Failed to insert embedding (thought was saved)"
      );
    }

    this.logger.info(
      { thoughtId: thought.id, source, noteType: resolvedNoteType },
      "Thought captured"
    );

    return ok(thought);
  }

  /**
   * Delete a thought and all associated data (embedding + metadata).
   * Returns true if the thought existed and was deleted.
   */
  delete(thoughtId: string): Result<boolean, AppError> {
    this.logger.info({ thoughtId }, "Deleting thought");

    // Delete metadata first (topics, people, actions)
    if (this.metadataRepo) {
      const metaResult = this.metadataRepo.deleteByThoughtId(thoughtId);
      if (metaResult.isErr()) {
        this.logger.warn(
          { thoughtId, error: metaResult.error },
          "Failed to delete metadata"
        );
      }
    }

    // Delete embedding
    const embResult = this.embeddingRepo.delete(thoughtId);
    if (embResult.isErr()) {
      this.logger.warn(
        { thoughtId, error: embResult.error },
        "Failed to delete embedding"
      );
    }

    // Delete thought
    const result = this.thoughtRepo.delete(thoughtId);
    if (result.isErr()) return err(result.error);

    if (result.value) {
      this.logger.info({ thoughtId }, "Thought deleted");
    }
    return ok(result.value);
  }

  /**
   * Update a thought's content and re-embed it.
   * Resets metadata_extracted so ExtractionWorker will re-process it.
   */
  async update(
    thoughtId: string,
    newContent: string
  ): Promise<Result<Thought, AppError>> {
    if (!newContent.trim()) {
      return err(new ValidationError("Content cannot be empty"));
    }

    this.logger.info({ thoughtId, contentLength: newContent.length }, "Updating thought");

    // Update content in DB
    const updateResult = this.thoughtRepo.updateContent(thoughtId, newContent);
    if (updateResult.isErr()) return err(updateResult.error);
    if (!updateResult.value) {
      return err(new ValidationError(`Thought not found: ${thoughtId}`));
    }

    // Re-embed with new content
    try {
      const embedding = await this.embeddingProvider.embed(newContent, "document");

      // Delete old embedding, insert new
      this.embeddingRepo.delete(thoughtId);
      const embResult = this.embeddingRepo.insert(thoughtId, embedding);
      if (embResult.isErr()) {
        this.logger.warn(
          { thoughtId, error: embResult.error },
          "Failed to update embedding"
        );
      }
    } catch (error) {
      this.logger.warn(
        { thoughtId, error },
        "Failed to re-embed updated thought"
      );
    }

    // Clear old metadata so extraction worker re-processes
    if (this.metadataRepo) {
      this.metadataRepo.deleteByThoughtId(thoughtId);
    }

    this.logger.info({ thoughtId }, "Thought updated");
    return ok(updateResult.value);
  }

  /**
   * Check if a near-duplicate thought already exists using vector similarity.
   * Uses L2 distance on normalized vectors (equivalent to cosine distance).
   */
  private checkDuplicate(embedding: Float32Array): DuplicateInfo {
    const searchResult = this.embeddingRepo.searchSimilar(embedding, 1);
    if (searchResult.isErr() || searchResult.value.length === 0) {
      return { isDuplicate: false };
    }

    const nearest = searchResult.value[0];
    if (nearest.distance < DUPLICATE_DISTANCE_THRESHOLD) {
      // Found a very similar thought — fetch it
      const thoughtResult = this.thoughtRepo.findById(nearest.thoughtId);
      if (thoughtResult.isOk() && thoughtResult.value) {
        return {
          isDuplicate: true,
          existingThought: thoughtResult.value,
          distance: nearest.distance,
        };
      }
    }

    return { isDuplicate: false };
  }
}
