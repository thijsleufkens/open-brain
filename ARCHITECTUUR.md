# Open Brain — Architectuur & Beslissingen

> Persoonlijk AI-geheugen voor Thijs Leufkens (Datawijs)
> Doel: laagdrempelige input, proactieve en reactieve inzichten, nul onderhoud

---

## Waarom dit project?

Elke AI-sessie begint met een leeg geheugen. Ideeën, besluiten en context gaan
verloren tussen sessies en tools. Notion wordt niet bijgehouden omdat het
discipline vereist die er niet is.

Dit systeem lost dat op door:
- Input zo laagdrempelig mogelijk te maken (voice, foto, tekst via Telegram)
- Verwerking volledig automatisch te doen (geen structuur vereist bij input)
- Proactief relevante informatie terug te sturen zonder dat ernaar gevraagd wordt

---

## De drie lagen

```
TRECHTER              OPVANGBAK            OUTPUT
─────────────         ─────────────        ──────────────────────
Telegram (push)       brain.db             REACTIEF
  tekst                └── thoughts          → Claude Code zoekt context
  voice → tekst            ├── content       → bij elk gesprek beschikbaar
  foto → tekst             ├── embedding
                           ├── context     PROACTIEF
Mail (pull)                ├── metadata      → ochtendoverzicht via Telegram
Kalender (pull)            │   ├── topics    → follow-up reminders
Notion (pull)              │   ├── people    → patroon signalering
                           │   ├── actions   → "je had dit willen doen"
                           │   └── type
                           └── created_at

                      VERWERKING
                        Gemini 2.5 Flash
                        ├── audio transcriptie
                        ├── foto OCR / handschrift
                        ├── classificatie werk/privé
                        ├── metadata extractie
                        └── embedding generatie
```

---

## MVP Scope

**In scope:**
- Telegram bot als enige capture kanaal
- Tekst, voice memo, foto (whiteboard, notitie, document)
- Automatische classificatie: werk (Datawijs) vs privé
- Opslag in één brain.db
- Doorzoekbaar via MCP vanuit Claude Code
- Wekelijks proactief overzicht via Telegram

**Buiten scope (later):**
- Mail pull (M365)
- Kalender sync
- Notion import
- Gezin / Lisette context
- Human Door dashboard
- Multi-device / VPS deployment

---

## Architectuurkeuzes & Redenen

### Database: SQLite + sqlite-vec

**Keuze:** Één `brain.db` bestand met sqlite-vec extensie voor vector search
en FTS5 voor keyword search.

**Waarom niet Postgres?**
Client-server database met apart proces, geheugenreservering en maintenance.
Overkill voor duizenden records op één machine.

**Waarom niet ChromaDB?**
Apart Python-proces, eigen storage engine, twee crash-punten in plaats van één.

**Waarom sqlite-vec?**
- Draait in hetzelfde proces als de applicatie
- Één `.db` bestand = backup is `cp brain.db backup.db`
- Bij <100K records en 768 dims is brute-force k-NN ~5-10ms
- Migratie naar VPS later = bestand kopiëren

**FTS5 erbij:**
Vector search vindt semantisch verwante content. FTS5 vindt exacte keywords.
Samen via Reciprocal Rank Fusion (RRF) het beste van beide werelden.

---

### Eén DB, context als kolom

**Keuze:** Één `brain.db` met een `context` kolom ('werk' | 'privé')
in plaats van aparte databases per domein.

**Waarom?**
- Simpelste oplossing die werkt
- Dezelfde trechter voor alles — geen beslissing bij input
- Later splitsen = één migratiescript
- Gezin / Lisette context komt later, aparte DB dan

---

### Capture kanaal: Telegram

**Keuze:** Telegram bot als primaire en enige input voor MVP.

**Waarom Telegram en niet WhatsApp?**
- WhatsApp Bot API is betaald en complex
- Telegram Bot API is gratis, open en uitstekend gedocumenteerd
- Voice memo's zijn direct downloadbaar als `.ogg`
- Foto's direct via API beschikbaar
- Thijs gebruikt Telegram niet privé → dedicated kanaal, altijd bovenaan,
  geen ruis van andere gesprekken

**Waarom niet eigen app?**
Een eigen app vereist een nieuwe gewoonte én bouwtijd.
Telegram is in 30 minuten werkend en zit al op de telefoon.

---

### Verwerkingsmodel: Gemini 2.5 Flash

**Keuze:** Gemini 2.5 Flash voor transcriptie, OCR, classificatie
en metadata extractie. Gemini-embedding-001 voor embeddings.

**Waarom Gemini en niet Anthropic/OpenAI?**
- Native multimodaal: audio, foto en tekst in één API call
- Geen aparte Whisper instantie nodig voor transcriptie
- Gemini-embedding-001 ondersteunt Matryoshka (768 dims = 95% kwaliteit
  van 3072, 4x minder opslag)
- `task_type` asymmetrie: RETRIEVAL_DOCUMENT bij opslaan,
  RETRIEVAL_QUERY bij zoeken

**Waarom 2.5 Flash en niet 3 Flash?**
Gemini 3 Flash is nog in preview (december 2025). Voor een MVP is stabiel
belangrijker dan bleeding edge. Swap naar 3 Flash zodra GA via config wijziging.

**Twee-fase verwerking:**
- Fase A (instant, ~200ms): embed + store → Telegram bevestiging
- Fase B (achtergrond): Gemini metadata extractie
Capture voelt altijd snel, ook als de extractie even duurt.

---

### MCP Server: stdio transport

**Keuze:** MCP server met stdio transport voor lokaal gebruik via Claude Code.

**Waarom?**
Claude Code verbindt via stdio — geen netwerk, geen auth, geen overhead.
HTTP transport (voor remote access) komt later bij VPS deployment.

**Tools:**
- `capture_thought` — opslaan + embedden
- `search_thoughts` — semantisch + keyword zoeken (RRF)
- `list_recent_thoughts` — recente items met paginatie
- `get_action_items` — open actiepunten
- `get_brain_stats` — statistieken
- `list_topics` — topics op frequentie

---

### Proactieve output: Telegram bot (zelfde kanaal)

**Keuze:** Dezelfde Telegram bot die input ontvangt stuurt ook
proactieve berichten terug.

**Waarom?**
- Één kanaal, twee richtingen — geen extra app
- Geplande taak (cron) draait 's ochtends, stuurt overzicht
- Bot herkent patronen: ideeën die te lang liggen, follow-ups, actiepunten

**Triggers:**
- Elke maandagochtend: LinkedIn-ideeën overzicht
- Bij > 7 dagen geen contact met prospect: reminder
- Actiepunten uit gesprekken die nog open staan

---

### Runtime: TypeScript / Node.js

**Keuze:** TypeScript met better-sqlite3, MCP SDK, grammy (Telegram).

**Waarom TypeScript?**
- MCP SDK is TypeScript-first
- better-sqlite3 is de snelste synchrone SQLite binding voor Node.js
- Patronen uit Talon (Ivo's project) direct herbruikbaar
- Zod voor runtime type validation op API grenzen

---

## Bestandsstructuur (target)

```
open-brain/
  src/
    db/
      connection.ts        # SQLite verbinding + WAL mode
      migrations/          # Versioned SQL migrations
      repositories/
        thought.ts         # ThoughtRepository
        embedding.ts       # EmbeddingRepository
        metadata.ts        # MetadataRepository
    services/
      capture.ts           # Capture pipeline (validate → embed → store)
      search.ts            # Search service (vector + FTS5 + RRF)
      metadata.ts          # Async Gemini extractie
      scheduler.ts         # Proactieve taken (cron)
    mcp/
      server.ts            # MCP stdio server
      tools/               # Tool definities
    telegram/
      bot.ts               # grammy bot
      handlers/
        text.ts            # Tekst berichten
        voice.ts           # Voice memo verwerking
        photo.ts           # Foto verwerking
    gemini/
      embeddings.ts        # Gemini embedding client
      extraction.ts        # Metadata extractie
      transcription.ts     # Audio → tekst
  data/
    brain.db               # SQLite database (gitignored)
  tests/
  CLAUDE.md
  ARCHITECTUUR.md
  Dockerfile
  docker-compose.yml
  docker-compose.prod.yml    # voor VPS later
  package.json
  tsconfig.json
  .env.example
```

**Docker aanpak:**
- Lokaal: `docker compose up -d` — zelfde image als productie
- brain.db als volume gemount buiten container: `./data:/app/data`
- Swap naar VPS = zelfde image, andere compose file

---

## Fasering

### Fase 1: Core (bouwen nu)
- [ ] Project scaffolding (TS, Vitest, Pino, Zod)
- [ ] Docker setup (Dockerfile + docker-compose.yml)
- [ ] SQLite + sqlite-vec setup met migraties
- [ ] Gemini embedding client (768 dims, L2 normalisatie)
- [ ] ThoughtRepository, EmbeddingRepository, MetadataRepository
- [ ] CaptureService: validate → embed → store
- [ ] SearchService: vector + FTS5 met RRF
- [ ] MCP stdio server met 6 tools

### Fase 2: Telegram Trechter
- [ ] grammy bot setup
- [ ] Tekst handler → capture
- [ ] Voice handler → Gemini transcriptie → capture
- [ ] Foto handler → Gemini OCR → capture
- [ ] Bevestiging terugsturen

### Fase 3: Metadata & Classificatie
- [ ] Gemini Flash extractie (topics, mensen, acties, context werk/privé)
- [ ] Achtergrond worker voor async extractie
- [ ] Filters in search op context, topic, persoon

### Fase 4: Proactieve Output
- [ ] Scheduler (cron)
- [ ] Ochtendoverzicht via Telegram
- [ ] LinkedIn-ideeën reminder
- [ ] Actiepunten signalering

### Fase 5: Pull Bronnen
- [ ] M365 mail connector
- [ ] Kalender sync
- [ ] Notion import

---

## Kosten (schatting MVP)

| Post | Per maand |
|------|-----------|
| Gemini embedding (100 items/dag) | ~€0.02 |
| Gemini Flash (transcriptie + extractie) | ~€0.05 |
| Docker lokaal (Mac) | €0.00 |
| **Totaal MVP lokaal** | **~€0.10** |

Later bij VPS: +€4.35/maand (Hetzner CX22) — zelfde Docker image

---

## Referenties

- [Open Brain concept — Nate B. Jones](https://promptkit.natebjones.com/20260224_uq1_guide_main)
- [open-brain — Han Rusman](https://github.com/hanrusman/open-brain)
- [Talon — Ivo Toby](https://github.com/ivo-toby/talon)
- [obsidian-autopilot — Ivo Toby](https://github.com/ivo-toby/obsidian-autopilot-backend)
- [Gemini Embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [grammy Telegram bot framework](https://grammy.dev)
