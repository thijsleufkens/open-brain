import type { Context } from "grammy";
import type { TelegramBotDeps } from "./bot.js";

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

function truncate(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function escapeMarkdown(text: string): string {
  // Escape MarkdownV2 special chars
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function formatThought(t: {
  content: string;
  noteType: string;
  createdAt: string;
  source: string;
}): string {
  const date = t.createdAt.replace("T", " ").replace("Z", "");
  const typeEmoji = noteTypeEmoji(t.noteType);
  const preview =
    t.content.length > 200 ? t.content.slice(0, 200) + "..." : t.content;
  return `${typeEmoji} *${date}*\n${preview}`;
}

function noteTypeEmoji(noteType: string): string {
  switch (noteType) {
    case "idea":
      return "💡";
    case "meeting":
      return "🤝";
    case "decision":
      return "⚖️";
    case "task":
      return "✅";
    case "reference":
      return "📚";
    case "journal":
      return "📓";
    default:
      return "💭";
  }
}

export function createHandlers(deps: TelegramBotDeps) {
  const { thoughtService, searchService, thoughtRepo, metadataRepo, logger } =
    deps;

  return {
    /** /start — Welcome message */
    async start(ctx: Context) {
      await ctx.reply(
        "🧠 *Open Brain* — je persoonlijke kennisbank\n\n" +
          "Stuur een bericht om een gedachte vast te leggen\\.\n\n" +
          "*Commando's:*\n" +
          "/search `<query>` — Zoek in je gedachten\n" +
          "/recent — Recente gedachten\n" +
          "/stats — Statistieken\n" +
          "/topics — Top topics\n" +
          "/actions — Open actiepunten\n" +
          "/help — Dit bericht",
        { parse_mode: "MarkdownV2" }
      );
    },

    /** /help — Same as start */
    async help(ctx: Context) {
      await ctx.reply(
        "🧠 *Open Brain — Commando's*\n\n" +
          "💬 *Elk bericht* → wordt opgeslagen als gedachte\n" +
          "🔍 /search `<query>` → semantisch zoeken\n" +
          "🕐 /recent → laatste 10 gedachten\n" +
          "📊 /stats → statistieken\n" +
          "🏷️ /topics → meest voorkomende topics\n" +
          "✅ /actions → open actiepunten",
        { parse_mode: "MarkdownV2" }
      );
    },

    /** Any text message → capture as thought */
    async capture(ctx: Context) {
      const text = ctx.message?.text;
      if (!text) return;

      logger.info(
        { userId: ctx.from?.id, contentLength: text.length },
        "Telegram capture"
      );

      const result = await thoughtService.capture({
        content: text,
        source: "telegram",
      });

      if (result.isErr()) {
        logger.error({ error: result.error }, "Failed to capture via Telegram");
        await ctx.reply("❌ Kon gedachte niet opslaan. Probeer het opnieuw.");
        return;
      }

      const thought = result.value;
      const typeEmoji = noteTypeEmoji(thought.noteType);
      await ctx.reply(
        `✅ Opgeslagen ${typeEmoji}\n\n_Metadata wordt op de achtergrond verwerkt_`,
        { parse_mode: "MarkdownV2" }
      );
    },

    /** /search <query> — Semantic + FTS search */
    async search(ctx: Context) {
      const text = ctx.message?.text ?? "";
      const query = text.replace(/^\/search\s*/i, "").trim();

      if (!query) {
        await ctx.reply(
          "Gebruik: /search <zoekopdracht>\n\nBijvoorbeeld: /search vergadering met Sarah"
        );
        return;
      }

      logger.info({ userId: ctx.from?.id, query }, "Telegram search");

      const result = await searchService.search({ query, limit: 5 });

      if (result.isErr()) {
        logger.error({ error: result.error }, "Telegram search failed");
        await ctx.reply("❌ Zoeken mislukt. Probeer het opnieuw.");
        return;
      }

      const results = result.value;

      if (results.length === 0) {
        await ctx.reply(`🔍 Geen resultaten voor "${query}"`);
        return;
      }

      const lines = results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        const matchIcon =
          r.matchType === "both"
            ? "🎯"
            : r.matchType === "vector"
              ? "🧠"
              : "📝";
        return `${i + 1}. ${matchIcon} ${formatThought(r.thought)}\n   _Score: ${score}_`;
      });

      const msg = `🔍 *Resultaten voor "${query}":*\n\n${lines.join("\n\n")}`;
      await ctx.reply(truncate(msg));
    },

    /** /recent — List recent thoughts */
    async recent(ctx: Context) {
      logger.info({ userId: ctx.from?.id }, "Telegram recent");

      const result = thoughtRepo.findRecent(10);

      if (result.isErr()) {
        await ctx.reply("❌ Kon recente gedachten niet ophalen.");
        return;
      }

      const thoughts = result.value;

      if (thoughts.length === 0) {
        await ctx.reply("📭 Nog geen gedachten opgeslagen. Stuur een bericht!");
        return;
      }

      const lines = thoughts.map(
        (t, i) => `${i + 1}. ${formatThought(t)}`
      );

      const msg = `🕐 *Recente gedachten:*\n\n${lines.join("\n\n")}`;
      await ctx.reply(truncate(msg));
    },

    /** /stats — Brain statistics */
    async stats(ctx: Context) {
      logger.info({ userId: ctx.from?.id }, "Telegram stats");

      const result = thoughtRepo.getStats();

      if (result.isErr()) {
        await ctx.reply("❌ Kon statistieken niet ophalen.");
        return;
      }

      const s = result.value;

      const sourceLines = Object.entries(s.bySource)
        .map(([source, count]) => `  ${source}: ${count}`)
        .join("\n");

      const typeLines = Object.entries(s.byNoteType)
        .map(([type, count]) => `  ${noteTypeEmoji(type)} ${type}: ${count}`)
        .join("\n");

      const msg =
        `📊 *Brain Stats*\n\n` +
        `🧠 Totaal: ${s.totalThoughts} gedachten\n\n` +
        `📡 Per bron:\n${sourceLines}\n\n` +
        `🏷️ Per type:\n${typeLines}`;

      await ctx.reply(truncate(msg));
    },

    /** /topics — Top topics by frequency */
    async topics(ctx: Context) {
      logger.info({ userId: ctx.from?.id }, "Telegram topics");

      const result = metadataRepo.listTopics(15);

      if (result.isErr()) {
        await ctx.reply("❌ Kon topics niet ophalen.");
        return;
      }

      const topics = result.value;

      if (topics.length === 0) {
        await ctx.reply(
          "🏷️ Nog geen topics geëxtraheerd. Sla eerst een paar gedachten op!"
        );
        return;
      }

      const lines = topics.map(
        (t, i) => `${i + 1}. ${t.topic} (${t.count}x)`
      );

      const msg = `🏷️ *Top Topics:*\n\n${lines.join("\n")}`;
      await ctx.reply(truncate(msg));
    },

    /** /actions — Open action items */
    async actions(ctx: Context) {
      logger.info({ userId: ctx.from?.id }, "Telegram actions");

      const result = metadataRepo.listActions("open", 15);

      if (result.isErr()) {
        await ctx.reply("❌ Kon actiepunten niet ophalen.");
        return;
      }

      const actions = result.value;

      if (actions.length === 0) {
        await ctx.reply("✅ Geen open actiepunten — alles afgewerkt!");
        return;
      }

      const lines = actions.map((a, i) => {
        const due = a.dueDate ? ` (deadline: ${a.dueDate})` : "";
        return `${i + 1}. ${a.actionText}${due}`;
      });

      const msg = `✅ *Open Actiepunten:*\n\n${lines.join("\n")}`;
      await ctx.reply(truncate(msg));
    },
  };
}
