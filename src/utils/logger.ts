import pino from "pino";

export function createLogger(level: string = "info") {
  return pino({
    level,
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino/file", options: { destination: 2 } }
        : undefined,
  });
}

export type Logger = pino.Logger;
