#!/usr/bin/env node
/**
 * Open Brain CLI — command-line interface for your personal knowledge base.
 *
 * Usage:
 *   brain add "Your thought here"          — Capture a thought
 *   brain add --type meeting "Notes..."    — Capture with note type
 *   brain search "query"                   — Semantic + FTS search
 *   brain recent                           — List recent thoughts
 *   brain stats                            — Knowledge base statistics
 *   brain import <file>                    — Import thoughts from JSON/text file
 *   brain delete <id>                      — Delete a thought
 *
 * Environment: reads GEMINI_API_KEY and DB_PATH from env or .env file.
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { openDatabase } from "../db/database.js";
import { ThoughtRepository } from "../repositories/thought.repository.js";
import { EmbeddingRepository } from "../repositories/embedding.repository.js";
import { MetadataRepository } from "../repositories/metadata.repository.js";
import { GeminiEmbeddingProvider } from "../providers/gemini-embedding.js";
import { ThoughtService } from "../services/thought.service.js";
import { SearchService } from "../services/search.service.js";
import fs from "node:fs";
import path from "node:path";

// ANSI color helpers for terminal output
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function printUsage() {
  console.log(`
${bold("Open Brain CLI")} — personal knowledge base

${bold("Usage:")}
  brain add "Your thought here"          Capture a thought
  brain add --type meeting "Notes..."    Capture with note type
  brain search "query"                   Semantic + keyword search
  brain search --limit 5 "query"         Search with custom limit
  brain recent                           List recent thoughts
  brain recent --limit 5                 Limit recent thoughts
  brain stats                            Knowledge base statistics
  brain import <file>                    Import from JSON or text file
  brain delete <id>                      Delete a thought by ID
  brain help                             Show this message

${bold("Note types:")} idea, meeting, decision, task, reference, journal, other

${bold("Environment:")}
  GEMINI_API_KEY    Required — Gemini API key
  DB_PATH           Database path (default: ./data/brain.db)
`);
}

/** Initialize all dependencies needed for CLI operations */
function initDeps() {
  const config = loadConfig();
  const logger = createLogger("warn"); // Quiet for CLI

  const db = openDatabase({
    dbPath: config.dbPath,
    embeddingDimensions: config.embeddingDimensions,
    logger,
  });

  const embeddingProvider = new GeminiEmbeddingProvider(
    config.geminiApiKey,
    config.embeddingModel,
    config.embeddingDimensions,
    logger
  );

  const thoughtRepo = new ThoughtRepository(db);
  const embeddingRepo = new EmbeddingRepository(db, config.embeddingDimensions);
  const metadataRepo = new MetadataRepository(db);

  const thoughtService = new ThoughtService(
    thoughtRepo,
    embeddingRepo,
    embeddingProvider,
    logger,
    metadataRepo
  );

  const searchService = new SearchService(
    db,
    thoughtRepo,
    embeddingRepo,
    metadataRepo,
    embeddingProvider,
    logger
  );

  return { config, db, thoughtRepo, metadataRepo, thoughtService, searchService };
}

/** Parse a flag value from args: --flag value or --flag=value */
function getFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${flag}` && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith(`--${flag}=`)) {
      return args[i].split("=")[1];
    }
  }
  return undefined;
}

/** Get positional args (everything that's not a flag or flag value) */
function getPositional(args: string[]): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (args[i].startsWith("--")) {
      // Skip flag with separate value (--flag value)
      if (!args[i].includes("=")) skipNext = true;
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

// --- Command implementations ---

async function cmdAdd(args: string[]) {
  const noteType = getFlag(args, "type") ?? "idea";
  const positional = getPositional(args);
  const content = positional.join(" ").trim();

  if (!content) {
    console.error(red("Error: no content provided."));
    console.error('Usage: brain add "Your thought here"');
    process.exit(1);
  }

  const { thoughtService, db } = initDeps();

  const result = await thoughtService.capture({
    content,
    noteType,
    source: "cli",
  });

  db.close();

  if (result.isErr()) {
    console.error(red(`Error: ${result.error.message}`));
    process.exit(1);
  }

  const t = result.value;
  console.log(green("✅ Thought captured"));
  console.log(`${dim("ID:")}    ${t.id}`);
  console.log(`${dim("Type:")}  ${t.noteType}`);
  console.log(`${dim("Time:")}  ${t.createdAt}`);
}

async function cmdSearch(args: string[]) {
  const limit = parseInt(getFlag(args, "limit") ?? "10", 10);
  const topic = getFlag(args, "topic");
  const person = getFlag(args, "person");
  const positional = getPositional(args);
  const query = positional.join(" ").trim();

  if (!query) {
    console.error(red("Error: no query provided."));
    console.error('Usage: brain search "your query"');
    process.exit(1);
  }

  const { searchService, db } = initDeps();

  const result = await searchService.search({ query, limit, topic, person });
  db.close();

  if (result.isErr()) {
    console.error(red(`Error: ${result.error.message}`));
    process.exit(1);
  }

  const results = result.value;
  if (results.length === 0) {
    console.log(yellow("No matching thoughts found."));
    return;
  }

  console.log(bold(`Found ${results.length} thought(s):\n`));
  for (const [i, r] of results.entries()) {
    const t = r.thought;
    const matchIcon = r.matchType === "both" ? "🎯" : r.matchType === "vector" ? "🧠" : "📝";
    console.log(
      `${cyan(`${i + 1}.`)} ${matchIcon} ${dim(`[${t.noteType}]`)} ${dim(t.createdAt)}`
    );
    console.log(`   ${t.content.length > 200 ? t.content.slice(0, 200) + "..." : t.content}`);
    console.log(`   ${dim(`Score: ${r.score.toFixed(4)} | Match: ${r.matchType} | ID: ${t.id}`)}`);
    console.log();
  }
}

async function cmdRecent(args: string[]) {
  const limit = parseInt(getFlag(args, "limit") ?? "10", 10);
  const { thoughtRepo, db } = initDeps();

  const result = thoughtRepo.findRecent(limit);
  db.close();

  if (result.isErr()) {
    console.error(red(`Error: ${result.error.message}`));
    process.exit(1);
  }

  const thoughts = result.value;
  if (thoughts.length === 0) {
    console.log(yellow("No thoughts yet. Use 'brain add' to capture one!"));
    return;
  }

  console.log(bold(`Recent thoughts (${thoughts.length}):\n`));
  for (const [i, t] of thoughts.entries()) {
    console.log(`${cyan(`${i + 1}.`)} ${dim(`[${t.noteType}]`)} ${dim(t.createdAt)} ${dim(`(${t.source})`)}`);
    console.log(`   ${t.content.length > 200 ? t.content.slice(0, 200) + "..." : t.content}`);
    console.log(`   ${dim(`ID: ${t.id}`)}`);
    console.log();
  }
}

function cmdStats() {
  const { thoughtRepo, metadataRepo, db } = initDeps();

  const statsResult = thoughtRepo.getStats();
  const topicsResult = metadataRepo.listTopics(10);
  db.close();

  if (statsResult.isErr()) {
    console.error(red(`Error: ${statsResult.error.message}`));
    process.exit(1);
  }

  const s = statsResult.value;
  console.log(bold("📊 Brain Statistics\n"));
  console.log(`Total thoughts: ${bold(String(s.totalThoughts))}`);

  if (Object.keys(s.bySource).length > 0) {
    console.log(`\n${bold("By source:")}`);
    for (const [source, count] of Object.entries(s.bySource)) {
      console.log(`  ${source}: ${count}`);
    }
  }

  if (Object.keys(s.byNoteType).length > 0) {
    console.log(`\n${bold("By type:")}`);
    for (const [type, count] of Object.entries(s.byNoteType)) {
      console.log(`  ${type}: ${count}`);
    }
  }

  if (topicsResult.isOk() && topicsResult.value.length > 0) {
    console.log(`\n${bold("Top topics:")}`);
    for (const t of topicsResult.value) {
      console.log(`  ${t.topic} (${t.count}x)`);
    }
  }
}

async function cmdImport(args: string[]) {
  const positional = getPositional(args);
  const filePath = positional[0];

  if (!filePath) {
    console.error(red("Error: no file path provided."));
    console.error("Usage: brain import <file.json|file.txt>");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(red(`Error: file not found: ${resolved}`));
    process.exit(1);
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const ext = path.extname(resolved).toLowerCase();

  let items: { content: string; noteType?: string }[];

  if (ext === ".json") {
    // Expect array of { content, noteType? } objects
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(red("Error: JSON file must contain an array of objects with 'content' field."));
      process.exit(1);
    }
    items = parsed
      .filter((item: unknown): item is { content: string; noteType?: string } => {
        return (
          typeof item === "object" &&
          item !== null &&
          "content" in item &&
          typeof (item as Record<string, unknown>).content === "string"
        );
      });
  } else {
    // Plain text: each non-empty line is a thought
    items = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ content: line }));
  }

  if (items.length === 0) {
    console.error(yellow("No thoughts found in file."));
    return;
  }

  console.log(`Importing ${bold(String(items.length))} thought(s) from ${dim(resolved)}...\n`);

  const { thoughtService, db } = initDeps();
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, item] of items.entries()) {
    const result = await thoughtService.capture({
      content: item.content,
      noteType: item.noteType,
      source: "import",
    });

    if (result.isOk()) {
      success++;
      process.stdout.write(green("."));
    } else if (result.error.message.includes("Duplicate")) {
      skipped++;
      process.stdout.write(yellow("~"));
    } else {
      failed++;
      process.stdout.write(red("x"));
    }

    // Rate limit: small delay between API calls
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  db.close();
  console.log(`\n\n${bold("Import complete:")}`);
  console.log(`  ${green("✅ Imported:")} ${success}`);
  console.log(`  ${yellow("~ Skipped (duplicates):")} ${skipped}`);
  if (failed > 0) console.log(`  ${red("✗ Failed:")} ${failed}`);
}

async function cmdDelete(args: string[]) {
  const positional = getPositional(args);
  const thoughtId = positional[0];

  if (!thoughtId) {
    console.error(red("Error: no thought ID provided."));
    console.error("Usage: brain delete <thought-id>");
    process.exit(1);
  }

  const { thoughtService, db } = initDeps();

  const result = thoughtService.delete(thoughtId);
  db.close();

  if (result.isErr()) {
    console.error(red(`Error: ${result.error.message}`));
    process.exit(1);
  }

  if (result.value) {
    console.log(green(`✅ Thought ${thoughtId} deleted.`));
  } else {
    console.error(yellow(`Thought not found: ${thoughtId}`));
  }
}

// --- Main entry point ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case "add":
      await cmdAdd(commandArgs);
      break;
    case "search":
      await cmdSearch(commandArgs);
      break;
    case "recent":
      await cmdRecent(commandArgs);
      break;
    case "stats":
      cmdStats();
      break;
    case "import":
      await cmdImport(commandArgs);
      break;
    case "delete":
      await cmdDelete(commandArgs);
      break;
    default:
      console.error(red(`Unknown command: ${command}`));
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(red(`Fatal error: ${error.message}`));
  process.exit(1);
});
