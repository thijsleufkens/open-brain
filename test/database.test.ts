import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/db/database.js";
import { ThoughtRepository } from "../src/repositories/thought.repository.js";
import { EmbeddingRepository } from "../src/repositories/embedding.repository.js";
import { MetadataRepository } from "../src/repositories/metadata.repository.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-brain-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase({ dbPath, embeddingDimensions: 4, logger });
  return { db, dbPath, dir };
}

describe("ThoughtRepository", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let repo: ThoughtRepository;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;
    repo = new ThoughtRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and retrieves a thought", () => {
    const result = repo.insert("Test thought", "mcp", "idea", "test-model", 4);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const thought = result.value;
    expect(thought.content).toBe("Test thought");
    expect(thought.source).toBe("mcp");
    expect(thought.noteType).toBe("idea");
    expect(thought.id).toBeTruthy();

    const found = repo.findById(thought.id);
    expect(found.isOk()).toBe(true);
    if (found.isOk()) {
      expect(found.value?.content).toBe("Test thought");
    }
  });

  it("finds recent thoughts", () => {
    repo.insert("First", "mcp", "idea", "test", 4);
    repo.insert("Second", "telegram", "meeting", "test", 4);
    repo.insert("Third", "cli", "task", "test", 4);

    const result = repo.findRecent(10);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(3);
      // All three contents should be present
      const contents = result.value.map((t) => t.content);
      expect(contents).toContain("First");
      expect(contents).toContain("Second");
      expect(contents).toContain("Third");
    }
  });

  it("filters by source", () => {
    repo.insert("MCP thought", "mcp", "idea", "test", 4);
    repo.insert("Telegram thought", "telegram", "idea", "test", 4);

    const result = repo.findRecent(10, 0, { source: "mcp" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].content).toBe("MCP thought");
    }
  });

  it("returns stats", () => {
    repo.insert("A", "mcp", "idea", "test", 4);
    repo.insert("B", "telegram", "meeting", "test", 4);
    repo.insert("C", "mcp", "idea", "test", 4);

    const result = repo.getStats("all");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.totalThoughts).toBe(3);
      expect(result.value.bySource["mcp"]).toBe(2);
      expect(result.value.bySource["telegram"]).toBe(1);
      expect(result.value.byNoteType["idea"]).toBe(2);
    }
  });

  it("marks thought as extracted", () => {
    const ins = repo.insert("Extract me", "mcp", "idea", "test", 4);
    expect(ins.isOk()).toBe(true);
    if (!ins.isOk()) return;

    const id = ins.value.id;
    expect(ins.value.metadataExtracted).toBe(false);

    repo.markExtracted(id, '{"topics":["test"]}');

    const found = repo.findById(id);
    expect(found.isOk()).toBe(true);
    if (found.isOk()) {
      expect(found.value?.metadataExtracted).toBe(true);
      expect(found.value?.rawMetadata).toBe('{"topics":["test"]}');
    }
  });
});

describe("EmbeddingRepository", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let thoughtRepo: ThoughtRepository;
  let embRepo: EmbeddingRepository;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;
    thoughtRepo = new ThoughtRepository(db);
    embRepo = new EmbeddingRepository(db, 4);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and searches vectors", () => {
    // Insert two thoughts with embeddings
    const t1 = thoughtRepo.insert("Cats are great", "mcp", "idea", "test", 4);
    const t2 = thoughtRepo.insert("Dogs are fun", "mcp", "idea", "test", 4);
    expect(t1.isOk() && t2.isOk()).toBe(true);
    if (!t1.isOk() || !t2.isOk()) return;

    // Embeddings: t1 is close to [1,0,0,0], t2 is close to [0,1,0,0]
    embRepo.insert(t1.value.id, new Float32Array([1, 0, 0, 0]));
    embRepo.insert(t2.value.id, new Float32Array([0, 1, 0, 0]));

    // Search near t1
    const result = embRepo.searchSimilar(new Float32Array([0.9, 0.1, 0, 0]), 2);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(2);
      // t1 should be closer
      expect(result.value[0].thoughtId).toBe(t1.value.id);
    }
  });

  it("deletes vectors", () => {
    const t1 = thoughtRepo.insert("Test", "mcp", "idea", "test", 4);
    if (!t1.isOk()) return;

    embRepo.insert(t1.value.id, new Float32Array([1, 0, 0, 0]));
    embRepo.delete(t1.value.id);

    const result = embRepo.searchSimilar(new Float32Array([1, 0, 0, 0]), 5);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(0);
    }
  });
});

describe("MetadataRepository", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let thoughtRepo: ThoughtRepository;
  let metaRepo: MetadataRepository;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;
    thoughtRepo = new ThoughtRepository(db);
    metaRepo = new MetadataRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and lists topics", () => {
    const t = thoughtRepo.insert("About AI and ML", "mcp", "idea", "test", 4);
    if (!t.isOk()) return;

    metaRepo.insertTopics(t.value.id, ["AI", "Machine Learning"]);

    const topics = metaRepo.listTopics(10);
    expect(topics.isOk()).toBe(true);
    if (topics.isOk()) {
      expect(topics.value.length).toBe(2);
    }
  });

  it("inserts and lists actions", () => {
    const t = thoughtRepo.insert("Need to do stuff", "mcp", "task", "test", 4);
    if (!t.isOk()) return;

    metaRepo.insertActions(t.value.id, [
      { text: "Buy groceries", dueDate: "2026-03-15" },
      { text: "Call dentist" },
    ]);

    const actions = metaRepo.listActions("open", 10);
    expect(actions.isOk()).toBe(true);
    if (actions.isOk()) {
      expect(actions.value.length).toBe(2);
      const texts = actions.value.map((a) => a.actionText);
      expect(texts).toContain("Buy groceries");
      expect(texts).toContain("Call dentist");
    }
  });

  it("finds actions due on a specific date", () => {
    const t = thoughtRepo.insert("Reminders test", "mcp", "task", "test", 4);
    if (!t.isOk()) return;

    metaRepo.insertActions(t.value.id, [
      { text: "Pay KvK", dueDate: "2026-03-15" },
      { text: "Call dentist", dueDate: "2026-03-16" },
      { text: "No deadline" },
    ]);

    const result = metaRepo.findActionsDueOn("2026-03-15");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].actionText).toBe("Pay KvK");
    }
  });

  it("finds overdue actions", () => {
    const t = thoughtRepo.insert("Overdue test", "mcp", "task", "test", 4);
    if (!t.isOk()) return;

    metaRepo.insertActions(t.value.id, [
      { text: "Past due", dueDate: "2026-03-10" },
      { text: "Due today", dueDate: "2026-03-15" },
      { text: "Future", dueDate: "2026-03-20" },
    ]);

    const result = metaRepo.findOverdueActions("2026-03-15");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].actionText).toBe("Past due");
    }
  });

  it("finds actions due in a date range", () => {
    const t = thoughtRepo.insert("Range test", "mcp", "task", "test", 4);
    if (!t.isOk()) return;

    metaRepo.insertActions(t.value.id, [
      { text: "Before range", dueDate: "2026-03-14" },
      { text: "In range 1", dueDate: "2026-03-16" },
      { text: "In range 2", dueDate: "2026-03-18" },
      { text: "After range", dueDate: "2026-03-20" },
    ]);

    const result = metaRepo.findActionsDueInRange("2026-03-16", "2026-03-18");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(2);
      const texts = result.value.map((a) => a.actionText);
      expect(texts).toContain("In range 1");
      expect(texts).toContain("In range 2");
    }
  });

  it("excludes completed actions from date queries", () => {
    const t = thoughtRepo.insert("Completed test", "mcp", "task", "test", 4);
    if (!t.isOk()) return;

    metaRepo.insertActions(t.value.id, [
      { text: "Open action", dueDate: "2026-03-15" },
      { text: "Done action", dueDate: "2026-03-15" },
    ]);

    // Mark second action as completed
    const actions = metaRepo.listActions("open", 10);
    if (actions.isOk()) {
      const doneAction = actions.value.find((a) => a.actionText === "Done action");
      if (doneAction) {
        db.prepare("UPDATE actions SET completed = 1 WHERE id = ?").run(doneAction.id);
      }
    }

    const result = metaRepo.findActionsDueOn("2026-03-15");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].actionText).toBe("Open action");
    }
  });

  it("finds thoughts by topic", () => {
    const t1 = thoughtRepo.insert("AI thought", "mcp", "idea", "test", 4);
    const t2 = thoughtRepo.insert("Cooking thought", "mcp", "idea", "test", 4);
    if (!t1.isOk() || !t2.isOk()) return;

    metaRepo.insertTopics(t1.value.id, ["ai"]);
    metaRepo.insertTopics(t2.value.id, ["cooking"]);

    const result = metaRepo.findThoughtIdsByTopic("ai");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toContain(t1.value.id);
      expect(result.value).not.toContain(t2.value.id);
    }
  });
});

describe("FTS5 Integration", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let repo: ThoughtRepository;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dir = tmp.dir;
    repo = new ThoughtRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds thoughts via FTS", () => {
    repo.insert("The cat sat on the mat", "mcp", "idea", "test", 4);
    repo.insert("A dog played in the park", "mcp", "idea", "test", 4);

    const rows = db.prepare(
      `SELECT t.id, t.content FROM thoughts_fts fts
       JOIN thoughts t ON t.rowid = fts.rowid
       WHERE thoughts_fts MATCH '"cat"'`
    ).all() as { id: string; content: string }[];

    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("cat");
  });
});
