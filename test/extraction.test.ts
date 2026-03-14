import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/db/database.js";
import { ThoughtRepository } from "../src/repositories/thought.repository.js";
import { MetadataRepository } from "../src/repositories/metadata.repository.js";
import { ExtractionService } from "../src/services/extraction.service.js";
import { ExtractionWorker } from "../src/services/extraction.worker.js";
import { extractionResultSchema } from "../src/types/extraction.js";
import { getDutchDayName, buildExtractionPrompt } from "../src/providers/gemini-extraction.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-brain-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase({ dbPath, embeddingDimensions: 4, logger });
  return { db, dbPath, dir };
}

// Mock extraction provider that returns predictable results
function createMockProvider(overrides?: Partial<ReturnType<typeof extractionResultSchema.parse>>) {
  return {
    extract: vi.fn().mockResolvedValue({
      note_type: "idea",
      topics: ["typescript", "testing"],
      people: ["Alice"],
      action_items: [{ text: "Write more tests", due_date: "2026-04-01" }],
      dates_referenced: [{ date: "2026-04-01", context: "test deadline" }],
      ...overrides,
    }),
  };
}

describe("buildExtractionPrompt", () => {
  it("contains today's date in ISO format", () => {
    const prompt = buildExtractionPrompt();
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(today);
  });

  it("contains the Dutch day name", () => {
    const prompt = buildExtractionPrompt();
    const dayName = getDutchDayName(new Date());
    expect(prompt).toContain(dayName);
  });

  it("instructs to resolve relative dates", () => {
    const prompt = buildExtractionPrompt();
    expect(prompt).toContain("relatieve datums");
    expect(prompt).toContain("ALWAYS resolve relative dates");
  });
});

describe("getDutchDayName", () => {
  it("returns correct Dutch day names", () => {
    // 2026-03-16 is a Monday
    expect(getDutchDayName(new Date("2026-03-16"))).toBe("maandag");
    // 2026-03-14 is a Saturday
    expect(getDutchDayName(new Date("2026-03-14"))).toBe("zaterdag");
    // 2026-03-15 is a Sunday
    expect(getDutchDayName(new Date("2026-03-15"))).toBe("zondag");
  });
});

describe("extractionResultSchema", () => {
  it("validates a correct extraction result", () => {
    const input = {
      note_type: "meeting",
      topics: ["ai", "product"],
      people: ["Bob", "Carol"],
      action_items: [
        { text: "Send follow-up email", due_date: "2026-03-20" },
        { text: "Update roadmap", due_date: null },
      ],
      dates_referenced: [{ date: "2026-03-20", context: "follow-up deadline" }],
    };
    const result = extractionResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("applies defaults for missing arrays", () => {
    const input = { note_type: "idea" };
    const result = extractionResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topics).toEqual([]);
      expect(result.data.people).toEqual([]);
      expect(result.data.action_items).toEqual([]);
      expect(result.data.dates_referenced).toEqual([]);
    }
  });

  it("rejects invalid note_type", () => {
    const input = { note_type: "invalid_type" };
    const result = extractionResultSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects too many topics", () => {
    const input = {
      note_type: "idea",
      topics: Array.from({ length: 15 }, (_, i) => `topic${i}`),
    };
    const result = extractionResultSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("ExtractionService", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let thoughtRepo: ThoughtRepository;
  let metadataRepo: MetadataRepository;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;
    thoughtRepo = new ThoughtRepository(db);
    metadataRepo = new MetadataRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts metadata for a thought and stores it", async () => {
    const mockProvider = createMockProvider();
    const service = new ExtractionService(mockProvider as any, thoughtRepo, metadataRepo, logger);

    // Insert a thought
    const thought = thoughtRepo.insert("I met with Alice about TypeScript testing", "mcp", "idea", "test", 4);
    expect(thought.isOk()).toBe(true);
    if (!thought.isOk()) return;

    // Extract
    const success = await service.extractOne(thought.value);
    expect(success).toBe(true);
    expect(mockProvider.extract).toHaveBeenCalledWith(thought.value.content);

    // Verify topics stored
    const topics = metadataRepo.listTopics(10);
    expect(topics.isOk()).toBe(true);
    if (topics.isOk()) {
      const names = topics.value.map((t) => t.topic);
      expect(names).toContain("typescript");
      expect(names).toContain("testing");
    }

    // Verify people stored
    const peopleIds = metadataRepo.findThoughtIdsByPerson("Alice");
    expect(peopleIds.isOk()).toBe(true);
    if (peopleIds.isOk()) {
      expect(peopleIds.value).toContain(thought.value.id);
    }

    // Verify actions stored
    const actions = metadataRepo.listActions("open", 10);
    expect(actions.isOk()).toBe(true);
    if (actions.isOk()) {
      expect(actions.value.length).toBe(1);
      expect(actions.value[0].actionText).toBe("Write more tests");
      expect(actions.value[0].dueDate).toBe("2026-04-01");
    }

    // Verify thought marked as extracted
    const updated = thoughtRepo.findById(thought.value.id);
    expect(updated.isOk()).toBe(true);
    if (updated.isOk()) {
      expect(updated.value?.metadataExtracted).toBe(true);
      expect(updated.value?.rawMetadata).toBeTruthy();
    }
  });

  it("handles extraction with no metadata gracefully", async () => {
    const mockProvider = createMockProvider({
      topics: [],
      people: [],
      action_items: [],
      dates_referenced: [],
    });
    const service = new ExtractionService(mockProvider as any, thoughtRepo, metadataRepo, logger);

    const thought = thoughtRepo.insert("Just a random thought", "mcp", "idea", "test", 4);
    if (!thought.isOk()) return;

    const success = await service.extractOne(thought.value);
    expect(success).toBe(true);

    // Still marked as extracted
    const updated = thoughtRepo.findById(thought.value.id);
    if (updated.isOk()) {
      expect(updated.value?.metadataExtracted).toBe(true);
    }
  });

  it("handles provider failure gracefully", async () => {
    const mockProvider = {
      extract: vi.fn().mockRejectedValue(new Error("API timeout")),
    };
    const service = new ExtractionService(mockProvider as any, thoughtRepo, metadataRepo, logger);

    const thought = thoughtRepo.insert("Will fail", "mcp", "idea", "test", 4);
    if (!thought.isOk()) return;

    const success = await service.extractOne(thought.value);
    expect(success).toBe(false);

    // NOT marked as extracted — will be retried
    const updated = thoughtRepo.findById(thought.value.id);
    if (updated.isOk()) {
      expect(updated.value?.metadataExtracted).toBe(false);
    }
  });

  it("processes a batch of unextracted thoughts", async () => {
    const mockProvider = createMockProvider();
    const service = new ExtractionService(mockProvider as any, thoughtRepo, metadataRepo, logger);

    // Insert 3 thoughts
    thoughtRepo.insert("Thought 1", "mcp", "idea", "test", 4);
    thoughtRepo.insert("Thought 2", "mcp", "idea", "test", 4);
    thoughtRepo.insert("Thought 3", "mcp", "idea", "test", 4);

    const processed = await service.processBatch(10);
    expect(processed).toBe(3);
    expect(mockProvider.extract).toHaveBeenCalledTimes(3);

    // All should be extracted now
    const unextracted = thoughtRepo.findUnextracted(10);
    if (unextracted.isOk()) {
      expect(unextracted.value.length).toBe(0);
    }
  });

  it("returns 0 when no unextracted thoughts exist", async () => {
    const mockProvider = createMockProvider();
    const service = new ExtractionService(mockProvider as any, thoughtRepo, metadataRepo, logger);

    const processed = await service.processBatch(10);
    expect(processed).toBe(0);
    expect(mockProvider.extract).not.toHaveBeenCalled();
  });
});

describe("ExtractionWorker", () => {
  it("starts and stops without errors", () => {
    const mockService = { processBatch: vi.fn().mockResolvedValue(0) };
    const worker = new ExtractionWorker(mockService as any, logger, 100);

    worker.start();
    worker.stop();
  });

  it("calls processBatch on tick", async () => {
    const mockService = { processBatch: vi.fn().mockResolvedValue(2) };
    const worker = new ExtractionWorker(mockService as any, logger, 50);

    worker.start();

    // Wait for at least one tick
    await new Promise((resolve) => setTimeout(resolve, 120));

    worker.stop();

    expect(mockService.processBatch).toHaveBeenCalled();
  });
});
