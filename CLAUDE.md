# CLAUDE.md — Open Brain

Dit is het Open Brain project van Thijs Leufkens (Datawijs).
Lees ARCHITECTUUR.md voor de volledige context en beslissingen.

---

## Wat dit project is

Een persoonlijk AI-geheugen dat via Telegram gevoed wordt (tekst, voice, foto)
en via MCP beschikbaar is in Claude Code. Één SQLite database, geen externe
services behalve Gemini API.

---

## Taal & stijl

- **TypeScript strict mode** — altijd
- **Geen `any`** — gebruik Zod voor runtime validatie op grenzen
- **Result types** — gebruik `neverthrow` voor verwachte errors,
  geen vergeten try/catch
- **Logging** — Pino, structured JSON, altijd `logger.info/warn/error`,
  nooit `console.log`
- **Async** — `async/await`, geen callbacks
- **Imports** — ESM met `.js` extensies

---

## Projectstructuur

Houd je aan de structuur in ARCHITECTUUR.md.
Korte samenvatting:

```
src/
  db/           # database laag (connection, migrations, repositories)
  services/     # business logica (capture, search, metadata, scheduler)
  mcp/          # MCP server en tools
  telegram/     # grammy bot en handlers
  gemini/       # Gemini API clients (embeddings, extractie, transcriptie)
data/
  brain.db      # SQLite database — gitignored
tests/
```

---

## Database regels

- **WAL mode altijd aan** — `PRAGMA journal_mode=WAL`
- **Foreign keys aan** — `PRAGMA foreign_keys=ON`
- **Migraties** — elke schema wijziging als genummerd `.sql` bestand
  in `src/db/migrations/`
- **Repository pattern** — alle SQL in repository classes,
  nooit SQL buiten repositories
- **Nooit raw SQL** buiten de `db/` map

---

## Gemini API

- **Embeddings:** `gemini-embedding-001`, `outputDimensionality: 768`
- **task_type asymmetrie:**
  - Bij opslaan: `RETRIEVAL_DOCUMENT`
  - Bij zoeken: `RETRIEVAL_QUERY`
- **L2 normalisatie verplicht** bij 768 dims (niet bij 3072)
- **Metadata extractie:** `gemini-2.5-flash`, JSON output mode + Zod validatie
- **Audio transcriptie:** `gemini-2.5-flash`, native audio input
- **Foto OCR:** `gemini-2.5-flash`, native vision input

Alle Gemini clients zitten in `src/gemini/`.
Nooit direct Gemini API aanroepen buiten deze map.

---

## Capture pipeline

Twee-fase model — dit is belangrijk:

```
Fase A (synchroon, ~200ms):
  validate → embed → store → return success

Fase B (asynchroon, achtergrond):
  Gemini Flash → metadata extractie → update record
```

Fase A moet altijd snel zijn. Fase B mag falen en later herhaald worden.
Nooit Fase A blokkeren op Fase B.

---

## MCP Server

- **Transport:** stdio (voor Claude Code lokaal)
- **Tools:** zie ARCHITECTUUR.md voor volledige lijst
- **Validatie:** Zod schema op elke tool input
- **Errors:** nooit raw errors teruggeven, altijd mensleesbaar bericht

---

## Telegram Bot

- **Framework:** grammy
- **Handlers:** aparte file per message type
  (`text.ts`, `voice.ts`, `photo.ts`)
- **Altijd bevestigen** na succesvolle capture
- **Nooit stille fouten** — altijd feedback naar gebruiker bij error
- **User ID whitelist** — alleen Thijs zijn Telegram ID mag de bot gebruiken

---

## Testing

- **Framework:** Vitest
- **Coverage target:** 80%
- **Mock externe services:** Gemini API en Telegram altijd mocken in tests
- **Repository tests:** gebruik in-memory SQLite (`:memory:`)

---

## Environment variabelen

Altijd via `.env` file, nooit hardcoded.
Valideer bij startup met Zod:

```
GEMINI_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=
DB_PATH=./data/brain.db
```

---

## Docker

Docker is vereist vanaf Fase 1 — niet optioneel.

**Waarom vanaf het begin?**
De bot moet altijd bereikbaar zijn, ook als de MacBook dicht is.
Lokaal (Mac) en productie (Hetzner VPS) zijn identiek door Docker.
Geen "werkt op mijn machine" problemen.

**Structuur:**
```
Dockerfile          # multi-stage build
docker-compose.yml  # lokaal ontwikkelen
docker/
  caddy/            # Caddyfile voor VPS (later)
```

**Lokaal draaien:**
```bash
docker compose up -d
```

**Data persistentie:**
brain.db wordt gemount als volume — nooit in de container opslaan:
```yaml
volumes:
  - ./data:/app/data
```

---

## Wat je NIET doet

- Geen externe databases (Postgres, MongoDB, Redis)
- Geen HTTP server voor MVP (MCP via stdio)
- Geen frontend / dashboard voor MVP
- Geen multi-user support
- Geen `console.log` — gebruik Pino
- Geen `any` in TypeScript
- Geen SQL buiten repository classes

---

## Bouwvolgorde (plan mode)

Bouw in deze volgorde — niet vooruitlopen:

1. Project scaffolding + tooling + Docker setup
2. Database layer (connection, migraties, repositories)
3. Gemini embedding client
4. Capture service + search service
5. MCP stdio server met tools
6. Telegram bot (tekst eerst, dan voice, dan foto)
7. Async metadata extractie
8. Scheduler voor proactieve output

Begin met stap 1. Vraag bevestiging voor je naar stap 2 gaat.

---

## Referenties

- ARCHITECTUUR.md — volledige context en beslissingen
- [sqlite-vec docs](https://github.com/asg017/sqlite-vec)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [grammy docs](https://grammy.dev)
- [Gemini Embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- [neverthrow](https://github.com/supermacro/neverthrow)
