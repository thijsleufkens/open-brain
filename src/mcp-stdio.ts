import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./utils/logger.js";
import { openDatabase } from "./db/database.js";
import { ThoughtRepository } from "./repositories/thought.repository.js";
import { EmbeddingRepository } from "./repositories/embedding.repository.js";
import { MetadataRepository } from "./repositories/metadata.repository.js";
import { GeminiEmbeddingProvider } from "./providers/gemini-embedding.js";
import { GeminiExtractionProvider } from "./providers/gemini-extraction.js";
import { GeminiTranscriptionProvider } from "./providers/gemini-transcription.js";
import { GeminiVisionProvider } from "./providers/gemini-vision.js";
import { ThoughtService } from "./services/thought.service.js";
import { SearchService } from "./services/search.service.js";
import { ExtractionService } from "./services/extraction.service.js";
import { ExtractionWorker } from "./services/extraction.worker.js";
import { SchedulerService } from "./services/scheduler.service.js";
import { createMcpServer } from "./mcp/server.js";
import { createTelegramBot } from "./telegram/bot.js";
import type { Bot } from "grammy";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info("Starting Open Brain MCP server (stdio)");

  // Initialize database
  const db = openDatabase({
    dbPath: config.dbPath,
    embeddingDimensions: config.embeddingDimensions,
    logger,
  });

  // Initialize providers
  const embeddingProvider = new GeminiEmbeddingProvider(
    config.geminiApiKey,
    config.embeddingModel,
    config.embeddingDimensions,
    logger
  );

  // Initialize repositories
  const thoughtRepo = new ThoughtRepository(db);
  const embeddingRepo = new EmbeddingRepository(db, config.embeddingDimensions);
  const metadataRepo = new MetadataRepository(db);

  // Initialize services
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

  // Initialize extraction (Phase 2)
  const extractionProvider = new GeminiExtractionProvider(
    config.geminiApiKey,
    config.extractionModel,
    logger
  );

  const extractionService = new ExtractionService(
    extractionProvider,
    thoughtRepo,
    metadataRepo,
    logger
  );

  const extractionWorker = new ExtractionWorker(extractionService, logger);
  extractionWorker.start();

  // Create MCP server
  const mcpServer = createMcpServer({
    thoughtService,
    searchService,
    thoughtRepo,
    metadataRepo,
    logger,
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logger.info("Open Brain MCP server running on stdio");

  // Initialize media providers (voice + photo)
  const transcriptionProvider = new GeminiTranscriptionProvider(
    config.geminiApiKey,
    config.extractionModel,
    logger
  );

  const visionProvider = new GeminiVisionProvider(
    config.geminiApiKey,
    config.extractionModel,
    logger
  );

  // Initialize Telegram bot (Phase 3) — conditional on token
  let telegramBot: Bot | undefined;
  let scheduler: SchedulerService | undefined;

  if (config.telegramBotToken) {
    try {
      telegramBot = createTelegramBot({
        token: config.telegramBotToken,
        allowedUsers: config.telegramAllowedUsers,
        thoughtService,
        searchService,
        thoughtRepo,
        metadataRepo,
        logger,
        transcriptionProvider,
        visionProvider,
      });

      // Start long-polling (non-blocking)
      telegramBot.start({
        onStart: () => {
          logger.info(
            { allowedUsers: config.telegramAllowedUsers },
            "Telegram bot started (long-polling)"
          );
        },
      });

      // Start scheduler for proactive output (Phase 4)
      if (config.telegramAllowedUsers.length > 0) {
        scheduler = new SchedulerService(
          telegramBot,
          { userId: config.telegramAllowedUsers[0] },
          thoughtRepo,
          metadataRepo,
          logger
        );
        scheduler.start();
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to start Telegram bot — MCP server continues without it"
      );
    }
  } else {
    logger.info("Telegram bot disabled (no TELEGRAM_BOT_TOKEN)");
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    if (scheduler) {
      scheduler.stop();
    }
    if (telegramBot) {
      await telegramBot.stop();
      logger.info("Telegram bot stopped");
    }
    extractionWorker.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
