/**
 * Database initialization — SQLite + sqlite-vec setup.
 *
 * Opens (or creates) a SQLite database with:
 * - WAL mode for concurrent read/write access
 * - sqlite-vec extension for vector similarity search
 * - Numbered SQL migrations applied automatically
 * - FTS5 virtual table for full-text keyword search
 *
 * The entire knowledge base lives in a single .db file,
 * making backups and migration between machines trivial.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DatabaseOptions {
  dbPath: string;
  embeddingDimensions: number;
  logger: Logger;
}

export function openDatabase(options: DatabaseOptions): Database.Database {
  const { dbPath, embeddingDimensions, logger } = options;

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info({ dir }, "Created data directory");
  }

  const db = new Database(dbPath);

  // SQLite pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");

  // Load sqlite-vec extension
  sqliteVec.load(db);
  logger.info("Loaded sqlite-vec extension");

  // Run migrations
  runMigrations(db, logger);

  // Create vec_thoughts virtual table (sqlite-vec doesn't support IF NOT EXISTS)
  createVecTable(db, embeddingDimensions, logger);

  logger.info({ dbPath }, "Database initialized");
  return db;
}

function runMigrations(db: Database.Database, logger: Logger): void {
  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);

  const currentVersion =
    (
      db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
        v: number | null;
      }
    )?.v ?? 0;

  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split("-")[0], 10);
    if (isNaN(version) || version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    logger.info({ version, file }, "Applied migration");
  }
}

function createVecTable(
  db: Database.Database,
  dimensions: number,
  logger: Logger
): void {
  // Defense-in-depth: validate dimensions even though config.ts already validates
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 4096) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}`);
  }
  // Check if vec_thoughts already exists
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_thoughts'"
    )
    .get();

  if (!exists) {
    db.exec(`
      CREATE VIRTUAL TABLE vec_thoughts USING vec0(
        thought_id TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      )
    `);
    logger.info({ dimensions }, "Created vec_thoughts virtual table");
  }
}
