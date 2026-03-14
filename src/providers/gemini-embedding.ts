/**
 * GeminiEmbeddingProvider — generates text embeddings via the Gemini REST API.
 *
 * Uses direct fetch() calls instead of the @google/generative-ai SDK because
 * the SDK doesn't reliably expose `outputDimensionality` for Matryoshka truncation.
 *
 * Key details:
 * - task_type asymmetry: RETRIEVAL_DOCUMENT for storage, RETRIEVAL_QUERY for search
 * - L2-normalization after truncation (required for correct cosine similarity)
 * - Implements the EmbeddingProvider interface for easy swap to local models later
 */
import type { EmbeddingProvider, TaskType } from "../types/embedding.js";
import { EmbeddingError } from "../types/errors.js";
import { l2Normalize } from "../utils/normalize.js";
import type { Logger } from "../utils/logger.js";

const TASK_TYPE_MAP: Record<TaskType, string> = {
  document: "RETRIEVAL_DOCUMENT",
  query: "RETRIEVAL_QUERY",
};

interface GeminiEmbedResponse {
  embedding: { values: number[] };
}

/**
 * Uses the Gemini REST API directly for full control over outputDimensionality.
 * The @google/generative-ai SDK doesn't expose this param in all versions.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    public readonly modelName: string,
    public readonly dimensions: number,
    private readonly logger: Logger
  ) {
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent`;
  }

  async embed(text: string, taskType: TaskType): Promise<Float32Array> {
    try {
      const body = {
        model: `models/${this.modelName}`,
        content: { parts: [{ text }] },
        taskType: TASK_TYPE_MAP[taskType],
        outputDimensionality: this.dimensions,
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
        throw new EmbeddingError(
          `Gemini API error (${response.status}): ${errorText}`
        );
      }

      const data = (await response.json()) as GeminiEmbedResponse;
      const values = data.embedding?.values;

      if (!values || values.length === 0) {
        throw new EmbeddingError("Empty embedding returned from Gemini API");
      }

      const vec = new Float32Array(values);

      // L2-normalize after Matryoshka truncation
      l2Normalize(vec);

      this.logger.debug(
        { taskType, dimensions: vec.length, textLength: text.length },
        "Generated embedding"
      );

      return vec;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(
        `Gemini embedding failed: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
