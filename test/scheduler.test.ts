import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SchedulerService } from "../src/services/scheduler.service.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "info" as const,
};

function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({}),
    },
  } as never;
}

function createMockThoughtRepo() {
  return {
    findRecent: vi.fn().mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    }),
    findById: vi.fn().mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: null,
    }),
    getStats: vi.fn().mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: { totalThoughts: 0, bySource: {}, byNoteType: {}, recentActivity: [] },
    }),
  } as never;
}

function createMockMetadataRepo() {
  return {
    listActions: vi.fn().mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    }),
    listTopics: vi.fn().mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    }),
    findThoughtIdsByTopic: vi.fn().mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    }),
  } as never;
}

describe("SchedulerService", () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (scheduler) scheduler.stop();
    vi.useRealTimers();
  });

  it("starts and stops without errors", () => {
    const bot = createMockBot();
    scheduler = new SchedulerService(
      bot,
      { userId: 123456 },
      createMockThoughtRepo(),
      createMockMetadataRepo(),
      mockLogger as never
    );

    scheduler.start();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 123456 }),
      "Scheduler started"
    );

    scheduler.stop();
    expect(mockLogger.info).toHaveBeenCalledWith("Scheduler stopped");
  });

  it("sends daily overview with overdue actions", async () => {
    const bot = createMockBot();
    const metadataRepo = createMockMetadataRepo();

    // Mock overdue action items
    vi.mocked(metadataRepo.listActions).mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [
        { actionText: "Stuur offerte naar klant", dueDate: "2026-03-10", completed: false },
        { actionText: "Review code", dueDate: "2026-03-20", completed: false },
      ],
    } as never);

    // Set time to 8am on a Tuesday
    vi.setSystemTime(new Date("2026-03-17T08:00:00"));

    scheduler = new SchedulerService(
      bot,
      { userId: 123456, morningHour: 8 },
      createMockThoughtRepo(),
      metadataRepo,
      mockLogger as never
    );

    scheduler.start();

    // Allow async tick to complete
    await vi.advanceTimersByTimeAsync(100);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      123456,
      expect.stringContaining("Verlopen actiepunten"),
      expect.objectContaining({ parse_mode: "Markdown" })
    );
  });

  it("does not send overview before morning hour", async () => {
    const bot = createMockBot();

    // Set time to 6am (before 8am morning hour)
    vi.setSystemTime(new Date("2026-03-17T06:00:00"));

    scheduler = new SchedulerService(
      bot,
      { userId: 123456, morningHour: 8 },
      createMockThoughtRepo(),
      createMockMetadataRepo(),
      mockLogger as never
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends weekly overview on Monday", async () => {
    const bot = createMockBot();
    const thoughtRepo = createMockThoughtRepo();
    const metadataRepo = createMockMetadataRepo();

    // Mock some weekly data
    vi.mocked(thoughtRepo.findRecent).mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [
        { content: "test", source: "telegram", noteType: "idea", createdAt: "2026-03-16T10:00:00Z" },
        { content: "test2", source: "mcp", noteType: "task", createdAt: "2026-03-15T10:00:00Z" },
      ],
    } as never);

    vi.mocked(metadataRepo.listTopics).mockReturnValue({
      isOk: () => true,
      isErr: () => false,
      value: [
        { topic: "ai", count: 5 },
        { topic: "product", count: 3 },
      ],
    } as never);

    // Set time to Monday 8am
    vi.setSystemTime(new Date("2026-03-16T08:00:00"));

    scheduler = new SchedulerService(
      bot,
      { userId: 123456, morningHour: 8 },
      thoughtRepo,
      metadataRepo,
      mockLogger as never
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    // Should send both daily and weekly
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);

    const weeklyCall = vi.mocked(bot.api.sendMessage).mock.calls.find(
      (call) => (call[1] as string).includes("Weekoverzicht")
    );
    expect(weeklyCall).toBeDefined();
  });
});
