import type { GeminiExtractionProvider } from "../providers/gemini-extraction.js";
import type { ThoughtRepository } from "../repositories/thought.repository.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";
import type { Thought } from "../types/thought.js";
import type { Logger } from "../utils/logger.js";

export class ExtractionService {
  constructor(
    private readonly extractionProvider: GeminiExtractionProvider,
    private readonly thoughtRepo: ThoughtRepository,
    private readonly metadataRepo: MetadataRepository,
    private readonly logger: Logger
  ) {}

  /**
   * Extract metadata for a single thought.
   * Stores topics, people, actions in normalized tables
   * and marks the thought as extracted.
   */
  async extractOne(thought: Thought): Promise<boolean> {
    try {
      const result = await this.extractionProvider.extract(thought.content);

      // Store topics
      if (result.topics.length > 0) {
        const topicResult = this.metadataRepo.insertTopics(thought.id, result.topics);
        if (topicResult.isErr()) {
          this.logger.error({ thoughtId: thought.id, error: topicResult.error }, "Failed to insert topics");
        }
      }

      // Store people
      if (result.people.length > 0) {
        const peopleResult = this.metadataRepo.insertPeople(thought.id, result.people);
        if (peopleResult.isErr()) {
          this.logger.error({ thoughtId: thought.id, error: peopleResult.error }, "Failed to insert people");
        }
      }

      // Store action items
      if (result.action_items.length > 0) {
        const actionsResult = this.metadataRepo.insertActions(
          thought.id,
          result.action_items.map((a) => ({
            text: a.text,
            dueDate: a.due_date ?? undefined,
          }))
        );
        if (actionsResult.isErr()) {
          this.logger.error({ thoughtId: thought.id, error: actionsResult.error }, "Failed to insert actions");
        }
      }

      // Update note_type if the LLM classified it differently and it was default
      // (only override if the original was "idea" — the default)
      if (thought.noteType === "idea" && result.note_type !== "idea") {
        const noteTypeResult = this.thoughtRepo.updateNoteType(thought.id, result.note_type);
        if (noteTypeResult.isErr()) {
          this.logger.error({ thoughtId: thought.id, error: noteTypeResult.error }, "Failed to update note_type");
        } else {
          this.logger.info(
            { thoughtId: thought.id, from: thought.noteType, to: result.note_type },
            "Updated note_type based on extraction"
          );
        }
      }

      // Mark as extracted with raw JSON
      const markResult = this.thoughtRepo.markExtracted(thought.id, JSON.stringify(result));
      if (markResult.isErr()) {
        this.logger.error({ thoughtId: thought.id, error: markResult.error }, "Failed to mark as extracted");
        return false;
      }

      this.logger.info(
        {
          thoughtId: thought.id,
          topics: result.topics,
          people: result.people,
          actions: result.action_items.length,
        },
        "Metadata extraction complete"
      );

      return true;
    } catch (error) {
      this.logger.error(
        { thoughtId: thought.id, error: error instanceof Error ? error.message : String(error) },
        "Metadata extraction failed"
      );
      return false;
    }
  }

  /**
   * Process a batch of unextracted thoughts.
   * Returns the number successfully processed.
   */
  async processBatch(batchSize: number = 5): Promise<number> {
    const unextracted = this.thoughtRepo.findUnextracted(batchSize);
    if (unextracted.isErr()) {
      this.logger.error({ error: unextracted.error }, "Failed to find unextracted thoughts");
      return 0;
    }

    const thoughts = unextracted.value;
    if (thoughts.length === 0) return 0;

    this.logger.info({ count: thoughts.length }, "Processing unextracted thoughts");

    let successCount = 0;
    for (const thought of thoughts) {
      const success = await this.extractOne(thought);
      if (success) successCount++;

      // Small delay between API calls to avoid rate limiting
      if (thoughts.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    return successCount;
  }
}
