/**
 * GeminiExtractionProvider — extracts structured metadata from thoughts via Gemini Flash.
 *
 * Sends the thought content to Gemini with a structured prompt, requesting JSON output.
 * The response is validated with Zod to ensure type safety.
 *
 * Extracts: note_type, topics, people, action_items, dates_referenced.
 * Runs asynchronously in Phase B of the two-phase capture model.
 */
import { extractionResultSchema, type ExtractionResult } from "../types/extraction.js";
import { AppError } from "../types/errors.js";
import type { Logger } from "../utils/logger.js";

const DUTCH_DAY_NAMES = [
  "zondag", "maandag", "dinsdag", "woensdag",
  "donderdag", "vrijdag", "zaterdag",
] as const;

function getDutchDayName(date: Date): string {
  return DUTCH_DAY_NAMES[date.getDay()];
}

function buildExtractionPrompt(): string {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dayName = getDutchDayName(now);

  return `You are a metadata extraction assistant. Analyze the following thought/note and extract structured metadata.

Vandaag is ${today} (${dayName}). Gebruik dit om relatieve datums als "maandag", "volgende week", "over 3 dagen", "morgen" naar absolute ISO datums (YYYY-MM-DD) te vertalen.

Rules:
- topics: 1-5 short lowercase topic labels (e.g. "infrastructure", "ai", "hiring")
- people: Full names of people explicitly mentioned. Do NOT infer people not named.
- action_items: Concrete tasks or commitments. Include due_date as ISO date (YYYY-MM-DD) if mentioned, otherwise null. ALWAYS resolve relative dates to absolute dates using today's date above.
- dates_referenced: Any specific dates mentioned with brief context.
- note_type: Classify as one of: idea, meeting, decision, task, reference, journal, other

Respond with ONLY valid JSON matching this exact schema:
{
  "note_type": "idea|meeting|decision|task|reference|journal|other",
  "topics": ["topic1", "topic2"],
  "people": ["Person Name"],
  "action_items": [{"text": "Do something", "due_date": "2026-03-15" or null}],
  "dates_referenced": [{"date": "2026-03-15", "context": "project deadline"}]
}

Thought to analyze:
`;
}

// Export for testing
export { getDutchDayName, buildExtractionPrompt };

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export class GeminiExtractionProvider {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
    private readonly logger: Logger
  ) {
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  }

  async extract(content: string): Promise<ExtractionResult> {
    const body = {
      contents: [
        {
          parts: [{ text: buildExtractionPrompt() + content }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `Gemini extraction API error (${response.status}): ${errorText}`,
        "EXTRACTION_API_ERROR"
      );
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new AppError(
        "Gemini extraction returned empty response",
        "EXTRACTION_EMPTY"
      );
    }

    // Parse JSON from LLM output
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.warn({ rawText: text.slice(0, 500) }, "Failed to parse extraction JSON");
      throw new AppError(
        "Gemini extraction returned invalid JSON",
        "EXTRACTION_PARSE_ERROR"
      );
    }

    // Validate with Zod
    const validated = extractionResultSchema.safeParse(parsed);
    if (!validated.success) {
      this.logger.warn(
        { errors: validated.error.issues, rawText: text.slice(0, 500) },
        "Extraction result failed Zod validation"
      );
      throw new AppError(
        `Extraction validation failed: ${validated.error.issues.map((i) => i.message).join(", ")}`,
        "EXTRACTION_VALIDATION_ERROR"
      );
    }

    this.logger.debug(
      {
        noteType: validated.data.note_type,
        topicCount: validated.data.topics.length,
        peopleCount: validated.data.people.length,
        actionCount: validated.data.action_items.length,
      },
      "Metadata extracted"
    );

    return validated.data;
  }
}
