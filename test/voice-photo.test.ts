import { describe, it, expect, vi } from "vitest";
import { GeminiTranscriptionProvider } from "../src/providers/gemini-transcription.js";
import { GeminiVisionProvider } from "../src/providers/gemini-vision.js";

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

describe("GeminiTranscriptionProvider", () => {
  it("transcribes audio data successfully", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "Dit is een test transcriptie" }],
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const provider = new GeminiTranscriptionProvider(
      "test-api-key",
      "gemini-2.5-flash",
      mockLogger as never
    );

    const result = await provider.transcribe(
      Buffer.from("fake-audio-data"),
      "audio/ogg"
    );

    expect(result).toBe("Dit is een test transcriptie");
    expect(fetch).toHaveBeenCalledTimes(1);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("audio/ogg");
    expect(body.contents[0].parts[0].inlineData.data).toBe(
      Buffer.from("fake-audio-data").toString("base64")
    );
  });

  it("throws on API error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const provider = new GeminiTranscriptionProvider(
      "test-api-key",
      "gemini-2.5-flash",
      mockLogger as never
    );

    await expect(
      provider.transcribe(Buffer.from("audio"), "audio/ogg")
    ).rejects.toThrow("Gemini transcription API error (500)");
  });

  it("throws on empty response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [] } }] }),
    });

    const provider = new GeminiTranscriptionProvider(
      "test-api-key",
      "gemini-2.5-flash",
      mockLogger as never
    );

    await expect(
      provider.transcribe(Buffer.from("audio"), "audio/ogg")
    ).rejects.toThrow("Gemini transcription returned empty response");
  });
});

describe("GeminiVisionProvider", () => {
  it("extracts text from image successfully", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "Tekst op het whiteboard: Sprint planning Q2" }],
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const provider = new GeminiVisionProvider(
      "test-api-key",
      "gemini-2.5-flash",
      mockLogger as never
    );

    const result = await provider.extractFromImage(
      Buffer.from("fake-image-data"),
      "image/jpeg"
    );

    expect(result).toBe("Tekst op het whiteboard: Sprint planning Q2");
    expect(fetch).toHaveBeenCalledTimes(1);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/jpeg");
  });

  it("throws on API error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limit exceeded"),
    });

    const provider = new GeminiVisionProvider(
      "test-api-key",
      "gemini-2.5-flash",
      mockLogger as never
    );

    await expect(
      provider.extractFromImage(Buffer.from("image"), "image/png")
    ).rejects.toThrow("Gemini vision API error (429)");
  });

  it("throws on empty response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ candidates: [{ content: { parts: [{}] } }] }),
    });

    const provider = new GeminiVisionProvider(
      "test-api-key",
      "gemini-2.5-flash",
      mockLogger as never
    );

    await expect(
      provider.extractFromImage(Buffer.from("image"), "image/jpeg")
    ).rejects.toThrow("Gemini vision returned empty response");
  });
});
