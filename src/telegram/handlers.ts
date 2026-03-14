import type { Context, Api } from "grammy";
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

async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string
): Promise<{ data: Buffer; filePath: string }> {
  const file = await api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) {
    throw new Error("Telegram did not return a file path");
  }

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return { data: Buffer.from(arrayBuffer), filePath };
}

function mimeTypeFromPath(filePath: string): string {
  if (filePath.endsWith(".oga") || filePath.endsWith(".ogg")) return "audio/ogg";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".wav")) return "audio/wav";
  if (filePath.endsWith(".m4a")) return "audio/mp4";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export function createHandlers(deps: TelegramBotDeps) {
  const { thoughtService, searchService, thoughtRepo, metadataRepo, logger } =
    deps;

  return {
    /** /start — Welcome message */
    async start(ctx: Context) {
      await ctx.reply(
        "🧠 *Open Brain* — je persoonlijke kennisbank\n\n" +
          "Stuur een bericht, voice memo of foto om een gedachte vast te leggen\\.\n\n" +
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
          "💬 *Tekst* → wordt opgeslagen als gedachte\n" +
          "🎙️ *Voice memo* → wordt getranscribeerd en opgeslagen\n" +
          "📷 *Foto* → wordt geanalyseerd en opgeslagen\n" +
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

    /** Voice/audio message → transcribe via Gemini → capture as thought */
    async voice(ctx: Context) {
      if (!deps.transcriptionProvider) return;

      const voice = ctx.message?.voice ?? ctx.message?.audio;
      if (!voice) return;

      logger.info(
        { userId: ctx.from?.id, duration: voice.duration, fileSize: voice.file_size },
        "Telegram voice capture"
      );

      await ctx.reply("🎙️ Voice memo ontvangen, wordt getranscribeerd...");

      try {
        const { data, filePath } = await downloadTelegramFile(
          ctx.api,
          deps.token,
          voice.file_id
        );
        const mimeType = mimeTypeFromPath(filePath);

        const transcription = await deps.transcriptionProvider.transcribe(
          data,
          mimeType
        );

        if (!transcription) {
          await ctx.reply("❌ Kon geen tekst herkennen in de voice memo.");
          return;
        }

        const result = await thoughtService.capture({
          content: `[Voice memo] ${transcription}`,
          source: "telegram",
        });

        if (result.isErr()) {
          logger.error({ error: result.error }, "Failed to capture voice via Telegram");
          await ctx.reply("❌ Kon voice memo niet opslaan. Probeer het opnieuw.");
          return;
        }

        const thought = result.value;
        const typeEmoji = noteTypeEmoji(thought.noteType);
        const preview =
          transcription.length > 300
            ? transcription.slice(0, 300) + "..."
            : transcription;
        await ctx.reply(
          `✅ Voice memo opgeslagen ${typeEmoji}\n\n📝 ${preview}\n\n_Metadata wordt op de achtergrond verwerkt_`
        );
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Voice transcription failed"
        );
        await ctx.reply(
          "❌ Fout bij het verwerken van de voice memo. Probeer het opnieuw."
        );
      }
    },

    /** Photo message → OCR via Gemini → capture as thought */
    async photo(ctx: Context) {
      if (!deps.visionProvider) return;

      const photos = ctx.message?.photo;
      if (!photos || photos.length === 0) return;

      // Telegram sends multiple sizes, pick the largest
      const photo = photos[photos.length - 1];

      logger.info(
        { userId: ctx.from?.id, width: photo.width, height: photo.height, fileSize: photo.file_size },
        "Telegram photo capture"
      );

      await ctx.reply("📷 Foto ontvangen, wordt geanalyseerd...");

      try {
        const { data, filePath } = await downloadTelegramFile(
          ctx.api,
          deps.token,
          photo.file_id
        );
        const mimeType = mimeTypeFromPath(filePath);

        const extractedText = await deps.visionProvider.extractFromImage(
          data,
          mimeType
        );

        if (!extractedText) {
          await ctx.reply("❌ Kon geen inhoud herkennen in de foto.");
          return;
        }

        const caption = ctx.message?.caption;
        const content = caption
          ? `[Foto: ${caption}] ${extractedText}`
          : `[Foto] ${extractedText}`;

        const result = await thoughtService.capture({
          content,
          source: "telegram",
        });

        if (result.isErr()) {
          logger.error({ error: result.error }, "Failed to capture photo via Telegram");
          await ctx.reply("❌ Kon foto niet opslaan. Probeer het opnieuw.");
          return;
        }

        const thought = result.value;
        const typeEmoji = noteTypeEmoji(thought.noteType);
        const preview =
          extractedText.length > 300
            ? extractedText.slice(0, 300) + "..."
            : extractedText;
        await ctx.reply(
          `✅ Foto opgeslagen ${typeEmoji}\n\n📝 ${preview}\n\n_Metadata wordt op de achtergrond verwerkt_`
        );
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Photo processing failed"
        );
        await ctx.reply(
          "❌ Fout bij het verwerken van de foto. Probeer het opnieuw."
        );
      }
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
