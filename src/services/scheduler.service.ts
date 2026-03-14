/**
 * SchedulerService — proactive output via Telegram.
 *
 * Runs on a fixed interval (default: every hour) and checks if any
 * scheduled tasks should fire based on the current time.
 *
 * Scheduled tasks:
 * - Morning overview (daily at configurable hour)
 * - Action item reminders (daily)
 * - Weekly overview with LinkedIn ideas (Monday mornings)
 */
import type { Bot } from "grammy";
import type { ThoughtRepository } from "../repositories/thought.repository.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";
import type { Logger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MORNING_HOUR = 8; // 08:00 local time

export interface SchedulerConfig {
  /** Telegram user ID to send proactive messages to */
  userId: number;
  /** Hour of the day to send morning overview (0-23, default: 8) */
  morningHour?: number;
}

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDailyRun: string | null = null;
  private lastWeeklyRun: string | null = null;
  private readonly morningHour: number;

  constructor(
    private readonly bot: Bot,
    private readonly config: SchedulerConfig,
    private readonly thoughtRepo: ThoughtRepository,
    private readonly metadataRepo: MetadataRepository,
    private readonly logger: Logger
  ) {
    this.morningHour = config.morningHour ?? MORNING_HOUR;
  }

  start(): void {
    if (this.timer) return;

    this.logger.info(
      { morningHour: this.morningHour, userId: this.config.userId },
      "Scheduler started"
    );

    // Check immediately, then every hour
    this.tick();
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("Scheduler stopped");
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday

    // Daily morning overview (once per day, at morning hour)
    if (hour >= this.morningHour && this.lastDailyRun !== today) {
      this.lastDailyRun = today;
      await this.sendDailyOverview(today);
    }

    // Weekly overview on Monday mornings
    if (dayOfWeek === 1 && hour >= this.morningHour && this.lastWeeklyRun !== today) {
      this.lastWeeklyRun = today;
      await this.sendWeeklyOverview();
    }
  }

  private async sendDailyOverview(today: string): Promise<void> {
    try {
      const parts: string[] = [];

      // 1. Actions due today — most prominent
      const todayResult = this.metadataRepo.findActionsDueOn(today);
      if (todayResult.isOk() && todayResult.value.length > 0) {
        parts.push(
          "🔔 *Vandaag te doen:*\n" +
            todayResult.value
              .map((a) => `• ${a.actionText}`)
              .join("\n")
        );
      }

      // 2. Overdue actions
      const overdueResult = this.metadataRepo.findOverdueActions(today);
      if (overdueResult.isOk() && overdueResult.value.length > 0) {
        parts.push(
          "⚠️ *Verlopen actiepunten:*\n" +
            overdueResult.value
              .map((a) => `• ${a.actionText} (deadline: ${a.dueDate})`)
              .join("\n")
        );
      }

      // 3. Due soon (tomorrow to +3 days)
      const tomorrow = this.addDays(today, 1);
      const threeDaysOut = this.addDays(today, 3);
      const soonResult = this.metadataRepo.findActionsDueInRange(tomorrow, threeDaysOut);
      if (soonResult.isOk() && soonResult.value.length > 0) {
        parts.push(
          "📅 *Binnenkort deadline:*\n" +
            soonResult.value
              .map((a) => `• ${a.actionText} (deadline: ${a.dueDate})`)
              .join("\n")
        );
      }

      // Fallback: show open action count if no date-based sections
      if (parts.length === 0) {
        const allOpen = this.metadataRepo.listActions("open", 100);
        if (allOpen.isOk() && allOpen.value.length > 0) {
          parts.push(`✅ ${allOpen.value.length} open actiepunten, geen deadlines binnenkort`);
        }
      }

      // Recent activity (yesterday)
      const yesterday = this.addDays(today, -1);
      const recentResult = this.thoughtRepo.findRecent(100, 0, {});
      if (recentResult.isOk()) {
        const yesterdayThoughts = recentResult.value.filter(
          (t) => t.createdAt.startsWith(yesterday)
        );
        if (yesterdayThoughts.length > 0) {
          parts.push(
            `📝 Gisteren ${yesterdayThoughts.length} gedachte${yesterdayThoughts.length === 1 ? "" : "n"} vastgelegd`
          );
        }
      }

      if (parts.length === 0) return; // Nothing to report

      const message = `🌅 *Goedemorgen — Open Brain*\n\n${parts.join("\n\n")}`;
      await this.bot.api.sendMessage(this.config.userId, message, {
        parse_mode: "Markdown",
      });

      this.logger.info("Daily overview sent");
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to send daily overview"
      );
    }
  }

  private async sendWeeklyOverview(): Promise<void> {
    try {
      const parts: string[] = [];
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = this.addDays(today, -7);

      // Count thoughts this week
      const recentResult = this.thoughtRepo.findRecent(500, 0, {});
      if (recentResult.isOk()) {
        const weekThoughts = recentResult.value.filter(
          (t) => t.createdAt >= weekAgo
        );
        if (weekThoughts.length > 0) {
          const bySrc: Record<string, number> = {};
          for (const t of weekThoughts) {
            bySrc[t.source] = (bySrc[t.source] ?? 0) + 1;
          }
          const srcLine = Object.entries(bySrc)
            .map(([s, c]) => `${s}: ${c}`)
            .join(", ");
          parts.push(
            `📊 *Deze week:* ${weekThoughts.length} gedachten (${srcLine})`
          );
        }
      }

      // Top topics this week
      const topicsResult = this.metadataRepo.listTopics(10, "week");
      if (topicsResult.isOk() && topicsResult.value.length > 0) {
        const topTopics = topicsResult.value.slice(0, 5);
        parts.push(
          "🏷️ *Top topics:*\n" +
            topTopics.map((t, i) => `${i + 1}. ${t.topic} (${t.count}x)`).join("\n")
        );
      }

      // LinkedIn content ideas (thoughts tagged with "linkedin" or "content" or "idea" noteType)
      const ideasResult = this.metadataRepo.findThoughtIdsByTopic("linkedin");
      if (ideasResult.isOk() && ideasResult.value.length > 0) {
        const recentIds = ideasResult.value.slice(0, 5);
        const ideas: string[] = [];
        for (const id of recentIds) {
          const thought = this.thoughtRepo.findById(id);
          if (thought.isOk() && thought.value) {
            const preview =
              thought.value.content.length > 100
                ? thought.value.content.slice(0, 100) + "..."
                : thought.value.content;
            ideas.push(`• ${preview}`);
          }
        }
        if (ideas.length > 0) {
          parts.push("💡 *LinkedIn ideeën:*\n" + ideas.join("\n"));
        }
      }

      // Open action items count
      const actionsResult = this.metadataRepo.listActions("open", 100);
      if (actionsResult.isOk() && actionsResult.value.length > 0) {
        parts.push(`✅ ${actionsResult.value.length} open actiepunten`);
      }

      if (parts.length === 0) return;

      const message = `📋 *Weekoverzicht — Open Brain*\n\n${parts.join("\n\n")}`;
      await this.bot.api.sendMessage(this.config.userId, message, {
        parse_mode: "Markdown",
      });

      this.logger.info("Weekly overview sent");
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to send weekly overview"
      );
    }
  }

  private addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
