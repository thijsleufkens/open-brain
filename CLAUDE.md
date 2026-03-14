# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Open Brain — persoonlijk AI-geheugen van Thijs Leufkens (Datawijs).
Input via Telegram (tekst, voice, foto), doorzoekbaar via MCP in Claude Code.
Één SQLite database, geen externe services behalve Gemini API.
Zie ARCHITECTUUR.md voor ontwerpbeslissingen.

## Commands

```bash
npm run build          # TypeScript compilatie + kopieert SQL migrations naar dist/
npm test               # Vitest — alle tests
npm run test:watch     # Vitest in watch mode
npx vitest run test/database.test.ts  # Enkele test file

npm run dev:stdio      # Dev MCP server (stdio, met tsx)
npm run dev            # Dev HTTP server + Telegram bot (met tsx)
npm run start:stdio    # Productie MCP server
npm run start          # Productie HTTP server

npm run typecheck      # tsc --noEmit
npm run brain -- search "query"  # CLI tool
```

Docker: `docker compose up -d` (lokaal) of `docker compose -f docker/docker-compose.yml up -d` (VPS met Caddy)

## Architecture

### Two-phase capture pipeline

```
Fase A (synchroon, ~200ms): validate → embed → dedup check → store
Fase B (asynchroon, elke 15s): ExtractionWorker → Gemini Flash → metadata
```

Fase A mag nooit blokkeren op Fase B. Fase B mag falen en wordt herhaald.

### Data flow

```
Telegram (text/voice/photo) ──→ ThoughtService.capture() ──→ SQLite
MCP tools ─────────────────────→ SearchService.search()  ──→ vector + FTS5 + RRF
SchedulerService ──────────────→ Telegram (proactieve berichten)
```

### Key layers

- **`src/providers/`** — Gemini API clients (embedding, extraction, transcription, vision). Alle Gemini calls zitten hier, nergens anders.
- **`src/repositories/`** — ThoughtRepository, EmbeddingRepository, MetadataRepository. Alle SQL zit hier, nergens anders.
- **`src/services/`** — ThoughtService (capture + dedup), SearchService (hybrid RRF), ExtractionService + Worker, SchedulerService.
- **`src/telegram/`** — grammy bot met handlers voor text, voice, photo, commands. Alles in `handlers.ts`.
- **`src/mcp/`** — MCP server met 8 tools (search, capture, list, stats, topics, actions, delete, update).
- **Entry points:** `mcp-stdio.ts` (Claude Code), `mcp-http.ts` (HTTP + auth), `cli/index.ts`.

### Search: hybrid vector + keyword

SearchService combineert sqlite-vec k-NN (vector) met FTS5 MATCH (keyword) via Reciprocal Rank Fusion (k=60). Query wordt ge-embed met task_type `RETRIEVAL_QUERY`, documents met `RETRIEVAL_DOCUMENT`.

### Duplicate detection

L2 distance < 0.10 op genormaliseerde vectoren (~cosine similarity > 0.95) blokkeert capture.

## Code conventions

- **TypeScript strict**, geen `any` — Zod voor runtime validatie op grenzen
- **`neverthrow` Result types** — services retourneren `Result<T, AppError>`, geen try/catch voor verwachte errors
- **Pino logging** — `logger.info/warn/error`, nooit `console.log`
- **ESM imports** met `.js` extensies
- **Repository pattern** — alle SQL in repository classes in `src/repositories/`
- **Gemini providers** — alle API calls in `src/providers/`, nooit elders

## Database

- SQLite met WAL mode, foreign keys aan, busy_timeout 5s
- sqlite-vec voor 768-dim vector search (brute-force k-NN)
- FTS5 voor keyword search
- Migraties als genummerde `.sql` bestanden in `src/db/migrations/`
- L2 normalisatie verplicht na Matryoshka truncatie naar 768 dims

## Testing

- Vitest, mocks voor Gemini API en Telegram
- Repository tests gebruiken temp SQLite bestanden (niet `:memory:` vanwege sqlite-vec)
- Mock embedding provider retourneert deterministische genormaliseerde vectoren

## Environment

Gevalideerd bij startup via Zod (`src/config.ts`):

- `GEMINI_API_KEY` (required)
- `TELEGRAM_BOT_TOKEN` (optional — bot start alleen als gezet)
- `TELEGRAM_ALLOWED_USERS` (comma-separated Telegram user IDs)
- `DB_PATH` (default: `./data/brain.db`)
- `EXTRACTION_MODEL` (default: `gemini-2.5-flash`)
