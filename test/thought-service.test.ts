/**
 * Tests for ThoughtService — capture, delete, update, and deduplication.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/db/database.js";
import { ThoughtRepository } from "../src/repositories/thought.repository.js";
import { EmbeddingRepository } from "../src/repositories/embedding.repository.js";
import { MetadataRepository } from "../src/repositories/metadata.repository.js";
import { ThoughtService } from "../src/services/thought.service.js";
import pino from "pino";

const logger = pino({ level: "silent" });
const DIMS = 4;

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-brain-ts-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase({ dbPath, embeddingDimensions: DIMS, logger });
  return { db, dbPath, dir };
}

/**
 * Creates a mock embedding provider where each call returns a slightly
 * different but reproducible vector. This simulates real embeddings
 * while keeping tests deterministic.
 */
function createMockEmbeddingProvider() {
  let callCount = 0;
  return {
    embed: vi.fn().mockImplementation(async () => {
      callCount++;
      const vec = new Float32Array(DIMS);
      for (let i = 0; i < DIMS; i++) {
        vec[i] = (callCount + i) / (DIMS + callCount);
      }
      let norm = 0;
      for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < DIMS; i++) vec[i] /= norm;
      return vec;
    }),
    dimensions: DIMS,
    modelName: "test-model",
  };
}

/**
 * Creates a mock that always returns the exact same vector,
 * triggering duplicate detection.
 */
function createDuplicateEmbeddingProvider() {
  const fixedVec = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) fixedVec[i] = 1 / Math.sqrt(DIMS);

  return {
    embed: vi.fn().mockResolvedValue(new Float32Array(fixedVec)),
    dimensions: DIMS,
    modelName: "test-model",
  };
}

describe("ThoughtService", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let thoughtRepo: ThoughtRepository;
  let embeddingRepo: EmbeddingRepository;
  let metadataRepo: MetadataRepository;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;
    thoughtRepo = new ThoughtRepository(db);
    embeddingRepo = new EmbeddingRepository(db, DIMS);
    metadataRepo = new MetadataRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("capture", () => {
    it("captures a thought and stores embedding", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const result = await service.capture({
        content: "Test thought",
        source: "cli",
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.content).toBe("Test thought");
        expect(result.value.source).toBe("cli");
      }
      expect(provider.embed).toHaveBeenCalledWith("Test thought", "document");
    });

    it("rejects empty content", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const result = await service.capture({ content: "" });
      expect(result.isErr()).toBe(true);
    });
  });

  describe("deduplication", () => {
    it("rejects duplicate thought with identical embedding", async () => {
      const provider = createDuplicateEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      // First capture should succeed
      const first = await service.capture({ content: "Original thought" });
      expect(first.isOk()).toBe(true);

      // Second capture with identical embedding should be rejected
      const second = await service.capture({ content: "Duplicate thought" });
      expect(second.isErr()).toBe(true);
      if (second.isErr()) {
        expect(second.error.message).toContain("Duplicate");
      }
    });

    it("allows sufficiently different thoughts", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const first = await service.capture({ content: "First thought" });
      const second = await service.capture({ content: "Second thought" });

      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
    });
  });

  describe("delete", () => {
    it("deletes a thought and returns true", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const captured = await service.capture({ content: "To be deleted" });
      expect(captured.isOk()).toBe(true);
      if (!captured.isOk()) return;

      const result = service.delete(captured.value.id);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(true);

      // Verify thought no longer exists
      const found = thoughtRepo.findById(captured.value.id);
      expect(found.isOk()).toBe(true);
      expect(found._unsafeUnwrap()).toBeNull();
    });

    it("returns false for non-existent thought", () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const result = service.delete("nonexistent-id");
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(false);
    });

    it("deletes associated metadata", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const captured = await service.capture({ content: "Thought with metadata" });
      if (!captured.isOk()) return;

      // Add metadata
      metadataRepo.insertTopics(captured.value.id, ["test-topic"]);
      metadataRepo.insertPeople(captured.value.id, ["Alice"]);
      metadataRepo.insertActions(captured.value.id, [{ text: "Do something" }]);

      // Delete
      service.delete(captured.value.id);

      // Verify metadata is gone
      const topicIds = metadataRepo.findThoughtIdsByTopic("test-topic");
      expect(topicIds.isOk()).toBe(true);
      expect(topicIds._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe("update", () => {
    it("updates content and re-embeds", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const captured = await service.capture({ content: "Original content" });
      if (!captured.isOk()) return;

      const embedCallsBefore = provider.embed.mock.calls.length;

      const updated = await service.update(
        captured.value.id,
        "Updated content"
      );

      expect(updated.isOk()).toBe(true);
      if (updated.isOk()) {
        expect(updated.value.content).toBe("Updated content");
      }

      // Should have called embed again for re-embedding
      expect(provider.embed.mock.calls.length).toBe(embedCallsBefore + 1);
    });

    it("rejects empty content", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const captured = await service.capture({ content: "Test" });
      if (!captured.isOk()) return;

      const result = await service.update(captured.value.id, "  ");
      expect(result.isErr()).toBe(true);
    });

    it("rejects non-existent thought", async () => {
      const provider = createMockEmbeddingProvider();
      const service = new ThoughtService(
        thoughtRepo, embeddingRepo, provider, logger, metadataRepo
      );

      const result = await service.update("nonexistent", "New content");
      expect(result.isErr()).toBe(true);
    });
  });
});
