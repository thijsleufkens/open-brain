/**
 * GeminiVisionProvider — extracts text/content from images via Gemini Flash.
 *
 * Uses native vision input (base64 inline data) for OCR, handwriting recognition,
 * whiteboard capture, document scanning, etc.
 */
import { AppError } from "../types/errors.js";
import type { Logger } from "../utils/logger.js";

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

const VISION_PROMPT =
  "Analyze this image and extract all relevant information. " +
  "If it contains text (printed, handwritten, or on a whiteboard), transcribe it accurately. " +
  "If it's a diagram, flowchart, or visual concept, describe its structure and content. " +
  "If it's a document or screenshot, extract the key content. " +
  "Return the extracted content as clear, structured text. " +
  "Preserve the original language (Dutch or English).";

export class GeminiVisionProvider {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
    private readonly logger: Logger
  ) {
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  }

  /**
   * Extract text/content from an image.
   * @param imageData - Raw image bytes as Buffer
   * @param mimeType - MIME type (e.g. "image/jpeg", "image/png")
   */
  async extractFromImage(imageData: Buffer, mimeType: string): Promise<string> {
    const base64Image = imageData.toString("base64");

    const body = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Image,
              },
            },
            { text: VISION_PROMPT },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
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
        `Gemini vision API error (${response.status}): ${errorText}`,
        "VISION_API_ERROR"
      );
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new AppError(
        "Gemini vision returned empty response",
        "VISION_EMPTY"
      );
    }

    this.logger.info(
      { mimeType, imageSizeBytes: imageData.length, textLength: text.length },
      "Image content extracted"
    );

    return text.trim();
  }
}
