import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/db/database.js";
import { ThoughtRepository } from "../src/repositories/thought.repository.js";
import { EmbeddingRepository } from "../src/repositories/embedding.repository.js";
import { MetadataRepository } from "../src/repositories/metadata.repository.js";
import { ThoughtService } from "../src/services/thought.service.js";
import { SearchService } from "../src/services/search.service.js";
import { createHandlers } from "../src/telegram/handlers.js";
import pino from "pino";

const logger = pino({ level: "silent" });

const DIMS = 4;

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-brain-tg-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase({ dbPath, embeddingDimensions: DIMS, logger });
  return { db, dbPath, dir };
}

// Mock embedding provider that returns deterministic vectors
function createMockEmbeddingProvider() {
  let callCount = 0;
  return {
    embed: vi.fn().mockImplementation(async () => {
      callCount++;
      const vec = new Float32Array(DIMS);
      // Slightly different vector per call to get some variety
      for (let i = 0; i < DIMS; i++) {
        vec[i] = (callCount + i) / (DIMS + callCount);
      }
      // L2 normalize
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

// Create a mock grammy Context
function createMockContext(overrides?: {
  text?: string;
  userId?: number;
}) {
  const replies: string[] = [];
  return {
    from: { id: overrides?.userId ?? 12345 },
    message: { text: overrides?.text ?? "" },
    reply: vi.fn().mockImplementation(async (text: string) => {
      replies.push(text);
    }),
    _replies: replies,
  };
}

describe("Telegram Handlers", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let thoughtRepo: ThoughtRepository;
  let embeddingRepo: EmbeddingRepository;
  let metadataRepo: MetadataRepository;
  let thoughtService: ThoughtService;
  let searchService: SearchService;
  let handlers: ReturnType<typeof createHandlers>;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;

    const embeddingProvider = createMockEmbeddingProvider();

    thoughtRepo = new ThoughtRepository(db);
    embeddingRepo = new EmbeddingRepository(db, DIMS);
    metadataRepo = new MetadataRepository(db);

    thoughtService = new ThoughtService(
      thoughtRepo,
      embeddingRepo,
      embeddingProvider,
      logger,
      metadataRepo
    );

    searchService = new SearchService(
      db,
      thoughtRepo,
      embeddingRepo,
      metadataRepo,
      embeddingProvider,
      logger
    );

    handlers = createHandlers({
      token: "test-token",
      allowedUsers: [],
      thoughtService,
      searchService,
      thoughtRepo,
      metadataRepo,
      logger,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("start/help", () => {
    it("replies with welcome message on /start", async () => {
      const ctx = createMockContext();
      await handlers.start(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Open Brain");
      expect(msg).toContain("/search");
    });

    it("replies with help message on /help", async () => {
      const ctx = createMockContext();
      await handlers.help(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("/search");
      expect(msg).toContain("/recent");
    });
  });

  describe("capture", () => {
    it("captures a plain text message as a thought", async () => {
      const ctx = createMockContext({
        text: "Dit is een testgedachte vanuit Telegram",
      });
      await handlers.capture(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("✅");
      expect(msg).toContain("Opgeslagen");

      // Verify it was stored
      const recent = thoughtRepo.findRecent(1);
      expect(recent.isOk()).toBe(true);
      if (recent.isOk()) {
        expect(recent.value.length).toBe(1);
        expect(recent.value[0].content).toBe(
          "Dit is een testgedachte vanuit Telegram"
        );
        expect(recent.value[0].source).toBe("telegram");
      }
    });

    it("replies with error when message text is empty", async () => {
      const ctx = createMockContext();
      // Override message to have no text
      ctx.message = { text: undefined as any };
      await handlers.capture(ctx as any);

      // Should not reply at all (silent return)
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("searches and returns results", async () => {
      // First capture some thoughts
      await thoughtService.capture({
        content: "Vergadering met Sarah over het project",
        source: "telegram",
      });
      await thoughtService.capture({
        content: "Idee voor een nieuw feature",
        source: "telegram",
      });

      const ctx = createMockContext({ text: "/search vergadering" });
      await handlers.search(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Resultaten");
    });

    it("replies with usage when no query provided", async () => {
      const ctx = createMockContext({ text: "/search" });
      await handlers.search(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Gebruik:");
    });

    it("replies with no results message when nothing matches", async () => {
      const ctx = createMockContext({
        text: "/search iets_dat_niet_bestaat_xyz",
      });
      await handlers.search(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Geen resultaten");
    });
  });

  describe("recent", () => {
    it("shows recent thoughts", async () => {
      await thoughtService.capture({
        content: "Eerste gedachte",
        source: "telegram",
      });
      await thoughtService.capture({
        content: "Tweede gedachte",
        source: "telegram",
      });

      const ctx = createMockContext();
      await handlers.recent(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Recente gedachten");
    });

    it("shows empty message when no thoughts exist", async () => {
      const ctx = createMockContext();
      await handlers.recent(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Nog geen gedachten");
    });
  });

  describe("stats", () => {
    it("shows brain statistics", async () => {
      await thoughtService.capture({
        content: "Test thought",
        source: "telegram",
      });

      const ctx = createMockContext();
      await handlers.stats(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Brain Stats");
      expect(msg).toContain("Totaal: 1");
      expect(msg).toContain("telegram");
    });
  });

  describe("topics", () => {
    it("shows empty topics message when no metadata extracted", async () => {
      const ctx = createMockContext();
      await handlers.topics(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Nog geen topics");
    });

    it("lists topics when metadata exists", async () => {
      // Insert a thought and manually add topics
      const thought = thoughtRepo.insert(
        "TypeScript is great",
        "telegram",
        "idea",
        "test",
        DIMS
      );
      if (!thought.isOk()) return;
      metadataRepo.insertTopics(thought.value.id, [
        "typescript",
        "programming",
      ]);

      const ctx = createMockContext();
      await handlers.topics(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Top Topics");
      expect(msg).toContain("typescript");
    });
  });

  describe("actions", () => {
    it("shows no actions message when none exist", async () => {
      const ctx = createMockContext();
      await handlers.actions(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Geen open actiepunten");
    });

    it("lists open action items", async () => {
      // Insert a thought and manually add actions
      const thought = thoughtRepo.insert(
        "Need to do things",
        "telegram",
        "task",
        "test",
        DIMS
      );
      if (!thought.isOk()) return;
      metadataRepo.insertActions(thought.value.id, [
        { text: "Deploy to production", dueDate: "2026-04-01" },
        { text: "Write documentation" },
      ]);

      const ctx = createMockContext();
      await handlers.actions(ctx as any);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const msg = ctx._replies[0];
      expect(msg).toContain("Open Actiepunten");
      expect(msg).toContain("Deploy to production");
      expect(msg).toContain("2026-04-01");
      expect(msg).toContain("Write documentation");
    });
  });
});
