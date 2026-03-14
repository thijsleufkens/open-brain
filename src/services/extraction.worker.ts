import type { ExtractionService } from "./extraction.service.js";
import type { Logger } from "../utils/logger.js";

const DEFAULT_INTERVAL_MS = 15_000; // 15 seconds
const DEFAULT_BATCH_SIZE = 5;

export class ExtractionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly extractionService: ExtractionService,
    private readonly logger: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly batchSize: number = DEFAULT_BATCH_SIZE
  ) {}

  start(): void {
    if (this.timer) return;

    this.logger.info(
      { intervalMs: this.intervalMs, batchSize: this.batchSize },
      "Extraction worker started"
    );

    // Run once immediately, then on interval
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("Extraction worker stopped");
    }
  }

  private async tick(): Promise<void> {
    // Prevent overlapping ticks
    if (this.running) return;
    this.running = true;

    try {
      const processed = await this.extractionService.processBatch(this.batchSize);
      if (processed > 0) {
        this.logger.info({ processed }, "Extraction worker tick complete");
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Extraction worker tick failed"
      );
    } finally {
      this.running = false;
    }
  }
}
