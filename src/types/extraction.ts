import { z } from "zod";

/**
 * Zod schema for the structured JSON that Gemini Flash returns.
 * Validated at runtime to catch malformed LLM output.
 */
export const extractionResultSchema = z.object({
  note_type: z
    .enum(["idea", "meeting", "decision", "task", "reference", "journal", "other"])
    .describe("The type of note"),
  topics: z
    .array(z.string().min(1).max(100))
    .max(10)
    .default([])
    .describe("Key topics or themes"),
  people: z
    .array(z.string().min(1).max(100))
    .max(20)
    .default([])
    .describe("People mentioned by name"),
  action_items: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        due_date: z.string().nullable().default(null),
      })
    )
    .max(10)
    .default([])
    .describe("Action items or tasks"),
  dates_referenced: z
    .array(
      z.object({
        date: z.string(),
        context: z.string().max(200).default(""),
      })
    )
    .max(10)
    .default([])
    .describe("Dates mentioned"),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;
