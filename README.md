# LeadSentry

A childhood lead-exposure risk **triage agent** for the Mireye Build Challenge.

Lead poisoning in kids is almost entirely preventable, but by the time it's
caught the damage is done. Health departments have the budget to test — not
the budget to figure out *which* addresses to knock on first. LeadSentry does
that triage: it reasons over physical-world data per address, scores risk,
and drafts the follow-up action (outreach letter, test-kit dispatch), with
every number cited to its source.

## What it combines

Mireye's catalog has no year-built field, so LeadSentry pairs Mireye with
**US Census ACS Table B25034 (Year Structure Built)** at the tract level,
joined through Mireye's `tract_geoid` field. Pre-1980 housing share is the
backbone of CDC/HUD's own lead-risk models.

| Score component | Weight | Source |
|---|---|---|
| Pre-1980 housing share | 0–50 | Census ACS B25034 (via free Census API key) |
| Legacy contamination (Superfund / brownfield / RCRA TSD / open LUST) | 0–30 | Mireye (EPA SEMS / ACRES / RCRA / UST Finder) |
| Water service gap (outside CWS area, high domestic-well density) | 0–20 | Mireye (EPA CWS Service Areas V3.0) |

Bands: 0–30 low, 31–60 moderate, 61–100 priority.

## It's an agent, not a script

A vendor-agnostic LLM (any provider — set `LLM_MODEL=provider:model`) drives
the loop: fetch Mireye facts → join Census tract data → compute the
deterministic score → **reason about data quality** (`parcel_grade=false`
caps confidence; heavy nulls downgrade it) → **decide and record an action**,
which writes a real artifact to `actions/`. On a tract where the score leans
almost entirely on the tract-level signal, the agent may file a live
`/v1/field-requests` asking Mireye to build a parcel-level year-built field.

No LLM key? It falls back to a clearly-labeled rule-based offline triage so
the pipeline still produces a complete report.

## Running it

```bash
npm install
cp .env.example .env    # MIREYE_API_TOKEN (code BUILD = free build tier),
                        # CENSUS_API_KEY (free, instant), LLM_MODEL=openai:gpt-4o
npm start -- --input data/sample-addresses.json --output report.md
```

Tokenless demo against clearly-labeled illustrative fixtures:

```bash
npm run demo
```

## ZIP-code mode (two-stage funnel)

Per-address triage across a whole ZIP is wasteful — the heavy signals are
tract-level anyway. ZIP mode screens an entire ZIP cheaply first:

```bash
npm start -- --zip 14213        # writes zip-14213-report.md
```

Stage 1 maps the ZIP to its census tracts (free Census ZCTA↔tract
relationship file + Gazetteer internal points, downloaded once and cached),
scores each tract with one Mireye point sample + one Census call, then the
agent turns the ranking into a **canvassing plan**: which tracts get
door-to-door saturation, which get mailers, which get monitored — and where
the expensive per-address stage-2 budget should go. Stage 2 is the existing
per-address pipeline (`--input`), run only on the tracts the plan flags.

First run downloads the 23 MB national relationship file (cached in
`data/cache/` afterwards; repeat runs are instant).

## Model portability

`LLM_MODEL` accepts any provider the Vercel AI SDK speaks:

- `openai:gpt-4o` (needs `OPENAI_API_KEY`)
- `anthropic:claude-sonnet-4-5` (needs `ANTHROPIC_API_KEY`)
- `google:gemini-2.5-flash` (needs `GOOGLE_GENERATIVE_AI_API_KEY`)
- `deepseek:deepseek-chat` or `deepseek:deepseek-reasoner` (needs `DEEPSEEK_API_KEY`) — cheapest hosted option
- `meta:muse-spark-1.2` (needs `MODEL_API_KEY` from llama.developer.meta.com — Meta Model API, 1M context)
- `openai-compatible:llama3.1` with `LLM_BASE_URL=http://localhost:11434/v1` (Ollama etc.)

Mireye is reached through its **hosted MCP server** (`api.mireye.com/mcp`)
with a bearer token; if MCP auth is refused, LeadSentry falls back to the
deterministic REST `/v1/fetch` automatically — same tools, same agent loop.

## Limitations / next steps

- ACS is tract-level, not parcel-level — a v2 would weight by block group.
- The contamination sub-score is a distance-threshold rule; a v2 would fit it
  against blood-lead surveillance data per tract.
- Water-service fields flag *regulatory* gaps (private wells), not confirmed
  lead service lines — EPA's Lead Service Line Inventory would sharpen this.
