import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

  logger.info("Starting Open Brain (HTTP + Telegram)");

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

  // Initialize extraction
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

  // --- Streamable HTTP MCP Server ---

  // Track active transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function createMcpTransport(): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
        logger.info({ sessionId }, "MCP session initialized");
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        logger.info({ sessionId: transport.sessionId }, "MCP session closed");
      }
    };

    return transport;
  }

  // Require AUTH_TOKEN for HTTP mode
  if (!config.authToken) {
    logger.error(
      "AUTH_TOKEN is required for HTTP mode. Set it in your .env file."
    );
    process.exit(1);
  }
  const authTokenBuffer = Buffer.from(config.authToken);

  // Bearer token auth check — timing-safe comparison to prevent side-channel attacks
  function authenticate(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;
    const spaceIdx = authHeader.indexOf(" ");
    if (spaceIdx === -1) return false;
    const scheme = authHeader.slice(0, spaceIdx);
    const token = authHeader.slice(spaceIdx + 1);
    if (scheme !== "Bearer" || !token) return false;
    const tokenBuffer = Buffer.from(token);
    if (tokenBuffer.length !== authTokenBuffer.length) return false;
    return timingSafeEqual(tokenBuffer, authTokenBuffer);
  }

  // Parse JSON body from request with size limit (1 MB max)
  const MAX_BODY_SIZE = 1_048_576;

  function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve(body ? JSON.parse(body) : undefined);
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  // Health check — minimal info without auth, detailed info with auth
  function handleHealth(req: IncomingMessage, res: ServerResponse) {
    if (authenticate(req)) {
      // Authenticated: return detailed stats
      const stats = thoughtRepo.getStats();
      const health = {
        status: "ok",
        version: "0.1.0",
        uptime: process.uptime(),
        thoughts: stats.isOk() ? stats.value.totalThoughts : -1,
        activeSessions: transports.size,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
    } else {
      // Unauthenticated: only return alive/dead status
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    }
  }

  // Create HTTP server
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS — restrict to same-origin or configured origins
    const origin = req.headers.origin;
    const allowedOrigin = origin === `http://localhost:${config.mcpPort}` ? origin : null;
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — no auth needed
    if (pathname === "/health" && req.method === "GET") {
      handleHealth(req, res);
      return;
    }

    // MCP endpoint — auth required
    if (pathname === "/mcp") {
      if (!authenticate(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "POST") {
          const body = await parseBody(req);

          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports.has(sessionId)) {
            // Existing session
            transport = transports.get(sessionId)!;
          } else if (!sessionId || (body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).method === "initialize")) {
            // New session — no session ID, or unknown session ID with initialize request
            if (sessionId) {
              logger.warn({ sessionId }, "Unknown session ID, accepting re-initialization");
            }
            transport = createMcpTransport();
            const mcpServer = createMcpServer({
              thoughtService,
              searchService,
              thoughtRepo,
              metadataRepo,
              logger,
            });
            await mcpServer.connect(transport);
          } else {
            // Unknown session ID with non-initialize request — client must re-initialize
            logger.warn({ sessionId }, "Unknown session ID, client must re-initialize");
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Session not found. Please re-initialize." },
                id: (body && typeof body === "object" && !Array.isArray(body))
                  ? (body as Record<string, unknown>).id ?? null
                  : null,
              })
            );
            return;
          }

          await transport.handleRequest(req, res, body);
        } else if (req.method === "GET") {
          // SSE stream for existing session
          if (!sessionId || !transports.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          await transports.get(sessionId)!.handleRequest(req, res);
        } else if (req.method === "DELETE") {
          // Session termination
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.close();
            transports.delete(sessionId);
          }
          res.writeHead(200);
          res.end();
        } else {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
        }
      } catch (error) {
        logger.error({ error }, "MCP HTTP request error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(config.mcpPort, () => {
    logger.info(
      { port: config.mcpPort, auth: !!config.authToken },
      "HTTP MCP server listening"
    );
  });

  // --- Media providers ---
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

  // --- Telegram bot (conditional) ---
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

      telegramBot.start({
        onStart: () => {
          logger.info(
            { allowedUsers: config.telegramAllowedUsers },
            "Telegram bot started (long-polling)"
          );
        },
      });

      // Start scheduler for proactive output
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
        "Failed to start Telegram bot — server continues without it"
      );
    }
  } else {
    logger.info("Telegram bot disabled (no TELEGRAM_BOT_TOKEN)");
  }

  // --- Graceful shutdown ---
  const shutdown = async () => {
    logger.info("Shutting down...");

    // Stop accepting new connections
    server.close();

    // Close all MCP sessions
    for (const [sessionId, transport] of transports) {
      try {
        await transport.close();
      } catch {
        logger.warn({ sessionId }, "Error closing MCP session");
      }
    }
    transports.clear();

    if (scheduler) {
      scheduler.stop();
    }

    if (telegramBot) {
      await telegramBot.stop();
      logger.info("Telegram bot stopped");
    }

    extractionWorker.stop();
    db.close();

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
