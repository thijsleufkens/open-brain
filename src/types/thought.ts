import { z } from "zod";

export const noteTypeSchema = z.enum([
  "idea",
  "meeting",
  "decision",
  "task",
  "reference",
  "journal",
  "other",
]);
export type NoteType = z.infer<typeof noteTypeSchema>;

export const sourceSchema = z.enum(["mcp", "telegram", "cli", "import"]);
export type Source = z.infer<typeof sourceSchema>;

export const thoughtSchema = z.object({
  id: z.string(),
  content: z.string().min(1),
  source: sourceSchema,
  noteType: noteTypeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number(),
  metadataExtracted: z.boolean(),
  rawMetadata: z.string().nullable(),
});
export type Thought = z.infer<typeof thoughtSchema>;

export const captureInputSchema = z.object({
  content: z.string().min(1, "Content cannot be empty").max(50_000, "Content too long (max 50k chars)"),
  noteType: noteTypeSchema.optional(),
  source: sourceSchema.optional().default("mcp"),
  skipMetadata: z.boolean().optional().default(false),
});
export type CaptureInput = z.infer<typeof captureInputSchema>;

export const searchInputSchema = z.object({
  query: z.string().min(1, "Query cannot be empty").max(2_000, "Query too long (max 2k chars)"),
  limit: z.number().int().positive().max(50).optional().default(10),
  source: sourceSchema.optional(),
  noteType: noteTypeSchema.optional(),
  topic: z.string().optional(),
  person: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

export interface SearchResult {
  thought: Thought;
  score: number;
  matchType: "vector" | "fts" | "both";
}

export interface BrainStats {
  totalThoughts: number;
  bySource: Record<string, number>;
  byNoteType: Record<string, number>;
  recentActivity: { date: string; count: number }[];
}
