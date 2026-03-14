/**
 * ThoughtRepository — all SQL operations for the thoughts table.
 *
 * Follows the Repository pattern: one class per entity, all SQL in one place.
 * The service layer never touches SQL directly.
 * All public methods return Result<T, DatabaseError> for explicit error handling.
 */
import type Database from "better-sqlite3";
import { ok, err, Result } from "neverthrow";
import type { Thought, BrainStats, Source, NoteType } from "../types/thought.js";
import { DatabaseError } from "../types/errors.js";

interface ThoughtRow {
  id: string;
  content: string;
  source: string;
  note_type: string;
  created_at: string;
  updated_at: string;
  embedding_model: string;
  embedding_dimensions: number;
  metadata_extracted: number;
  raw_metadata: string | null;
}

function rowToThought(row: ThoughtRow): Thought {
  return {
    id: row.id,
    content: row.content,
    source: row.source as Source,
    noteType: row.note_type as NoteType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    metadataExtracted: row.metadata_extracted === 1,
    rawMetadata: row.raw_metadata,
  };
}

export class ThoughtRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findRecentStmt;
  private readonly findRecentBySourceStmt;
  private readonly findRecentByTypeStmt;
  private readonly countStmt;
  private readonly findByIdsStmt;
  private readonly findUnextractedStmt;
  private readonly markExtractedStmt;
  private readonly deleteStmt;
  private readonly updateContentStmt;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO thoughts (id, content, source, note_type, embedding_model, embedding_dimensions)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
      RETURNING *
    `);

    this.findByIdStmt = db.prepare("SELECT * FROM thoughts WHERE id = ?");

    this.findRecentStmt = db.prepare(
      "SELECT * FROM thoughts ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );

    this.findRecentBySourceStmt = db.prepare(
      "SELECT * FROM thoughts WHERE source = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );

    this.findRecentByTypeStmt = db.prepare(
      "SELECT * FROM thoughts WHERE note_type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );

    this.countStmt = db.prepare("SELECT COUNT(*) as count FROM thoughts");

    this.findByIdsStmt = db.prepare(
      "SELECT * FROM thoughts WHERE id IN (SELECT value FROM json_each(?))"
    );

    this.findUnextractedStmt = db.prepare(
      "SELECT * FROM thoughts WHERE metadata_extracted = 0 ORDER BY created_at ASC LIMIT ?"
    );

    this.markExtractedStmt = db.prepare(
      "UPDATE thoughts SET metadata_extracted = 1, raw_metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    );

    this.deleteStmt = db.prepare("DELETE FROM thoughts WHERE id = ?");

    this.updateContentStmt = db.prepare(
      "UPDATE thoughts SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *"
    );
  }

  insert(
    content: string,
    source: string,
    noteType: string,
    embeddingModel: string,
    embeddingDimensions: number
  ): Result<Thought, DatabaseError> {
    try {
      const row = this.insertStmt.get(
        content,
        source,
        noteType,
        embeddingModel,
        embeddingDimensions
      ) as ThoughtRow;
      return ok(rowToThought(row));
    } catch (error) {
      return err(new DatabaseError("Failed to insert thought", error));
    }
  }

  findById(id: string): Result<Thought | null, DatabaseError> {
    try {
      const row = this.findByIdStmt.get(id) as ThoughtRow | undefined;
      return ok(row ? rowToThought(row) : null);
    } catch (error) {
      return err(new DatabaseError("Failed to find thought", error));
    }
  }

  findRecent(
    limit: number,
    offset: number = 0,
    filters?: { source?: string; noteType?: string }
  ): Result<Thought[], DatabaseError> {
    try {
      let rows: ThoughtRow[];
      if (filters?.source) {
        rows = this.findRecentBySourceStmt.all(
          filters.source,
          limit,
          offset
        ) as ThoughtRow[];
      } else if (filters?.noteType) {
        rows = this.findRecentByTypeStmt.all(
          filters.noteType,
          limit,
          offset
        ) as ThoughtRow[];
      } else {
        rows = this.findRecentStmt.all(limit, offset) as ThoughtRow[];
      }
      return ok(rows.map(rowToThought));
    } catch (error) {
      return err(new DatabaseError("Failed to find recent thoughts", error));
    }
  }

  findByIds(ids: string[]): Result<Thought[], DatabaseError> {
    try {
      if (ids.length === 0) return ok([]);
      const rows = this.findByIdsStmt.all(
        JSON.stringify(ids)
      ) as ThoughtRow[];
      return ok(rows.map(rowToThought));
    } catch (error) {
      return err(new DatabaseError("Failed to find thoughts by IDs", error));
    }
  }

  findUnextracted(limit: number): Result<Thought[], DatabaseError> {
    try {
      const rows = this.findUnextractedStmt.all(limit) as ThoughtRow[];
      return ok(rows.map(rowToThought));
    } catch (error) {
      return err(
        new DatabaseError("Failed to find unextracted thoughts", error)
      );
    }
  }

  markExtracted(
    id: string,
    rawMetadata: string
  ): Result<void, DatabaseError> {
    try {
      this.markExtractedStmt.run(rawMetadata, id);
      return ok(undefined);
    } catch (error) {
      return err(
        new DatabaseError("Failed to mark thought as extracted", error)
      );
    }
  }

  delete(id: string): Result<boolean, DatabaseError> {
    try {
      const result = this.deleteStmt.run(id);
      return ok(result.changes > 0);
    } catch (error) {
      return err(new DatabaseError("Failed to delete thought", error));
    }
  }

  updateContent(
    id: string,
    content: string
  ): Result<Thought | null, DatabaseError> {
    try {
      const row = this.updateContentStmt.get(content, id) as
        | ThoughtRow
        | undefined;
      return ok(row ? rowToThought(row) : null);
    } catch (error) {
      return err(new DatabaseError("Failed to update thought", error));
    }
  }

  getStats(
    period?: string
  ): Result<BrainStats, DatabaseError> {
    try {
      const total = (this.countStmt.get() as { count: number }).count;

      const bySource = this.db
        .prepare(
          "SELECT source, COUNT(*) as count FROM thoughts GROUP BY source"
        )
        .all() as { source: string; count: number }[];

      const byNoteType = this.db
        .prepare(
          "SELECT note_type, COUNT(*) as count FROM thoughts GROUP BY note_type"
        )
        .all() as { note_type: string; count: number }[];

      let dateFilter = "";
      if (period === "week") dateFilter = "AND created_at >= date('now', '-7 days')";
      else if (period === "month") dateFilter = "AND created_at >= date('now', '-30 days')";
      else if (period === "quarter") dateFilter = "AND created_at >= date('now', '-90 days')";
      else if (period === "year") dateFilter = "AND created_at >= date('now', '-365 days')";

      const recentActivity = this.db
        .prepare(
          `SELECT date(created_at) as date, COUNT(*) as count
           FROM thoughts
           WHERE 1=1 ${dateFilter}
           GROUP BY date(created_at)
           ORDER BY date DESC
           LIMIT 30`
        )
        .all() as { date: string; count: number }[];

      return ok({
        totalThoughts: total,
        bySource: Object.fromEntries(bySource.map((r) => [r.source, r.count])),
        byNoteType: Object.fromEntries(
          byNoteType.map((r) => [r.note_type, r.count])
        ),
        recentActivity,
      });
    } catch (error) {
      return err(new DatabaseError("Failed to get stats", error));
    }
  }
}
