/**
 * GeminiTranscriptionProvider — transcribes audio to text via Gemini Flash.
 *
 * Uses native audio input (base64 inline data) so no separate Whisper service is needed.
 * Supports OGG/OGA (Telegram voice), MP3, WAV, etc.
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

const TRANSCRIPTION_PROMPT =
  "Transcribe this audio message accurately. Return ONLY the transcription text, no commentary or labels. " +
  "If the audio is in Dutch, transcribe in Dutch. If in English, transcribe in English. " +
  "Preserve the original language.";

export class GeminiTranscriptionProvider {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
    private readonly logger: Logger
  ) {
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  }

  /**
   * Transcribe audio data to text.
   * @param audioData - Raw audio bytes as Buffer
   * @param mimeType - MIME type (e.g. "audio/ogg", "audio/mpeg")
   */
  async transcribe(audioData: Buffer, mimeType: string): Promise<string> {
    const base64Audio = audioData.toString("base64");

    const body = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
            { text: TRANSCRIPTION_PROMPT },
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
        `Gemini transcription API error (${response.status}): ${errorText}`,
        "TRANSCRIPTION_API_ERROR"
      );
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new AppError(
        "Gemini transcription returned empty response",
        "TRANSCRIPTION_EMPTY"
      );
    }

    this.logger.info(
      { mimeType, audioSizeBytes: audioData.length, textLength: text.length },
      "Audio transcribed"
    );

    return text.trim();
  }
}
