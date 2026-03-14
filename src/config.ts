/**
 * Configuration loader — validates all environment variables at startup via Zod.
 *
 * All config is sourced from environment variables (12-factor style).
 * Zod provides runtime type checking + coercion + defaults so the
 * rest of the application can rely on typed, validated config.
 *
 * Required:
 *   GEMINI_API_KEY — API key for Gemini embedding + extraction services
 *
 * Optional (with defaults):
 *   DB_PATH, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EXTRACTION_MODEL,
 *   LOG_LEVEL, MCP_PORT, AUTH_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS
 */
import { z } from "zod";
import path from "node:path";

const configSchema = z.object({
  geminiApiKey: z.string().min(1, "GEMINI_API_KEY is required"),
  dbPath: z.string().default("./data/brain.db"),
  embeddingDimensions: z.coerce.number().int().positive().default(768),
  embeddingModel: z.string().default("gemini-embedding-001"),
  extractionModel: z.string().default("gemini-2.5-flash"),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  mcpPort: z.coerce.number().int().positive().default(3000),
  authToken: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramAllowedUsers: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map(Number)
            .filter((n) => !isNaN(n))
        : []
    ),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const raw = {
    geminiApiKey: process.env.GEMINI_API_KEY,
    dbPath: process.env.DB_PATH,
    embeddingDimensions: process.env.EMBEDDING_DIMENSIONS,
    embeddingModel: process.env.EMBEDDING_MODEL,
    extractionModel: process.env.EXTRACTION_MODEL,
    logLevel: process.env.LOG_LEVEL,
    mcpPort: process.env.MCP_PORT,
    authToken: process.env.AUTH_TOKEN,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramAllowedUsers: process.env.TELEGRAM_ALLOWED_USERS,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  // Resolve DB path to absolute
  const config = result.data;
  if (!path.isAbsolute(config.dbPath)) {
    config.dbPath = path.resolve(process.cwd(), config.dbPath);
  }

  return config;
}
