-- Core thoughts table
CREATE TABLE IF NOT EXISTS thoughts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'mcp',
    note_type TEXT NOT NULL DEFAULT 'idea',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-exp-03-07',
    embedding_dimensions INTEGER NOT NULL DEFAULT 768,
    metadata_extracted INTEGER NOT NULL DEFAULT 0,
    raw_metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_source ON thoughts(source);
CREATE INDEX IF NOT EXISTS idx_thoughts_note_type ON thoughts(note_type);
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata_extracted ON thoughts(metadata_extracted)
    WHERE metadata_extracted = 0;

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
    content,
    content=thoughts,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS thoughts_fts_insert AFTER INSERT ON thoughts BEGIN
    INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS thoughts_fts_delete AFTER DELETE ON thoughts BEGIN
    INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS thoughts_fts_update AFTER UPDATE OF content ON thoughts BEGIN
    INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Metadata tables
CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_topics_topic ON topics(topic);
CREATE INDEX IF NOT EXISTS idx_topics_thought ON topics(thought_id);

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    person_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(person_name);
CREATE INDEX IF NOT EXISTS idx_people_thought ON people(thought_id);

CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    action_text TEXT NOT NULL,
    due_date TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_thought ON actions(thought_id);
CREATE INDEX IF NOT EXISTS idx_actions_completed ON actions(completed);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
