/**
 * EmbeddingRepository — vector storage and similarity search via sqlite-vec.
 *
 * Vectors are stored as raw Float32Array buffers in the vec_thoughts virtual table.
 * sqlite-vec performs brute-force k-NN search, which is exact (no recall loss)
 * and fast enough for <100K records at 768 dimensions (~5-10ms).
 */
import type Database from "better-sqlite3";
import { ok, err, Result } from "neverthrow";
import { DatabaseError } from "../types/errors.js";

export interface VecSearchResult {
  thoughtId: string;
  distance: number;
}

export class EmbeddingRepository {
  private readonly insertStmt;
  private readonly deleteStmt;

  constructor(
    private readonly db: Database.Database,
    private readonly dimensions: number
  ) {
    this.insertStmt = db.prepare(
      "INSERT INTO vec_thoughts (thought_id, embedding) VALUES (?, ?)"
    );

    this.deleteStmt = db.prepare(
      "DELETE FROM vec_thoughts WHERE thought_id = ?"
    );
  }

  insert(
    thoughtId: string,
    embedding: Float32Array
  ): Result<void, DatabaseError> {
    try {
      this.insertStmt.run(thoughtId, Buffer.from(embedding.buffer));
      return ok(undefined);
    } catch (error) {
      return err(new DatabaseError("Failed to insert embedding", error));
    }
  }

  delete(thoughtId: string): Result<void, DatabaseError> {
    try {
      this.deleteStmt.run(thoughtId);
      return ok(undefined);
    } catch (error) {
      return err(new DatabaseError("Failed to delete embedding", error));
    }
  }

  searchSimilar(
    queryEmbedding: Float32Array,
    limit: number
  ): Result<VecSearchResult[], DatabaseError> {
    try {
      const rows = this.db
        .prepare(
          `SELECT thought_id, distance
           FROM vec_thoughts
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`
        )
        .all(
          Buffer.from(queryEmbedding.buffer),
          limit
        ) as { thought_id: string; distance: number }[];

      return ok(
        rows.map((r) => ({
          thoughtId: r.thought_id,
          distance: r.distance,
        }))
      );
    } catch (error) {
      return err(new DatabaseError("Failed to search embeddings", error));
    }
  }
}
