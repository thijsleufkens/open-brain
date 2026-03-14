# Open Brain

Persoonlijk AI-geheugen dat via Telegram gevoed wordt (tekst, voice, foto) en via [MCP](https://modelcontextprotocol.io/) beschikbaar is in Claude Code.

## Wat het doet

- **Input via Telegram** — stuur tekst, voice memo's of foto's naar de bot
- **Automatische verwerking** — Gemini embeddings, transcriptie, OCR en metadata-extractie
- **Doorzoekbaar** — hybride vector + keyword search (RRF fusie) via MCP tools
- **Proactief** — dagelijks ochtendoverzicht en wekelijkse samenvatting via Telegram

## Architectuur

```
Telegram (tekst/voice/foto)
    ↓
Fase A: validate → embed → store (~200ms)
Fase B: Gemini Flash → metadata extractie (achtergrond)
    ↓
SQLite + sqlite-vec + FTS5 (brain.db)
    ↓
MCP Server (stdio/HTTP) → Claude Code
Scheduler → proactieve Telegram berichten
```

## Stack

| Component | Technologie |
|-----------|-------------|
| Runtime | TypeScript / Node.js 22+ |
| Database | SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec) + FTS5 |
| Embeddings | Gemini Embedding 001 (768 dims, Matryoshka) |
| Extractie | Gemini 2.5 Flash (metadata, transcriptie, OCR) |
| Telegram | [grammy](https://grammy.dev) |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Error handling | [neverthrow](https://github.com/supermacro/neverthrow) (Result types) |
| Validatie | Zod |
| Logging | Pino (structured JSON) |

## Quickstart

```bash
cp .env.example .env
# Vul GEMINI_API_KEY, TELEGRAM_BOT_TOKEN en TELEGRAM_ALLOWED_USERS in

npm install
npm run build
npm run start:stdio   # MCP server
# of
npm run start         # HTTP server + Telegram bot
```

### Docker

```bash
docker compose -f docker/docker-compose.yml up -d
```

## MCP Tools

| Tool | Beschrijving |
|------|-------------|
| `search_thoughts` | Semantisch + keyword zoeken met filters |
| `capture_thought` | Gedachte opslaan met embedding |
| `list_recent_thoughts` | Recente gedachten met paginatie |
| `get_brain_stats` | Statistieken over de kennisbank |
| `list_topics` | Topics op frequentie |
| `get_action_items` | Open/afgeronde actiepunten |
| `delete_thought` | Gedachte permanent verwijderen |
| `update_thought` | Inhoud bijwerken, opnieuw embedden |

## Credits

Gebaseerd op de implementatie van [Han Rusman](https://github.com/hanrusman/open-brain). Han's code vormde de productie-klare basis (~3.500 LOC) waar dit project op voortbouwt.

Geïnspireerd door het [Open Brain concept](https://promptkit.natebjones.com/20260224_uq1_guide_main) van Nate B. Jones en [Talon](https://github.com/ivo-toby/talon) van Ivo Toby.

## Licentie

MIT
