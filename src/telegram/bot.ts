import { Bot, session, type Context } from "grammy";
import type { Logger } from "../utils/logger.js";
import type { ThoughtService } from "../services/thought.service.js";
import type { SearchService } from "../services/search.service.js";
import type { ThoughtRepository } from "../repositories/thought.repository.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";
import { createHandlers } from "./handlers.js";

export interface TelegramBotDeps {
  token: string;
  allowedUsers: number[];
  thoughtService: ThoughtService;
  searchService: SearchService;
  thoughtRepo: ThoughtRepository;
  metadataRepo: MetadataRepository;
  logger: Logger;
}

export function createTelegramBot(deps: TelegramBotDeps): Bot {
  const { token, allowedUsers, logger } = deps;

  // Require at least one allowed user to prevent open access
  if (allowedUsers.length === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USERS is required when TELEGRAM_BOT_TOKEN is set. " +
      "Set it to a comma-separated list of Telegram user IDs."
    );
  }

  const bot = new Bot(token);

  // Auth middleware — only allow configured user IDs
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      logger.warn("Received message without user ID, ignoring");
      return;
    }

    if (!allowedUsers.includes(userId)) {
      logger.warn({ userId }, "Unauthorized Telegram user");
      await ctx.reply("⛔ Je bent niet geautoriseerd om deze bot te gebruiken.");
      return;
    }

    await next();
  });

  // Register handlers
  const handlers = createHandlers(deps);

  bot.command("start", handlers.start);
  bot.command("help", handlers.help);
  bot.command("search", handlers.search);
  bot.command("recent", handlers.recent);
  bot.command("stats", handlers.stats);
  bot.command("topics", handlers.topics);
  bot.command("actions", handlers.actions);

  // Any plain text message = capture thought
  bot.on("message:text", handlers.capture);

  // Error handler
  bot.catch((err) => {
    logger.error(
      { error: err.message, stack: err.stack },
      "Telegram bot error"
    );
  });

  return bot;
}
