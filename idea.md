# LeadSentry

A childhood lead-exposure risk agent for the Mireye Build Challenge.

Lead poisoning in kids is one of the few "silent epidemics" left in the US:
it is almost entirely preventable, but by the time it's caught the damage
(lowered IQ, developmental delay) is already done. Health departments have
the budget to test, but not the budget to figure out *which* addresses to
knock on first. LeadSentry does that triage.

## What it combines

Mireye's catalog is strong on terrain, hazards and utilities, but it doesn't
carry a year-built field. So LeadSentry pairs Mireye with **US Census ACS
Table B25034 (Year Structure Built)** at the tract level, joined through
Mireye's `tract_geoid` field. Pre-1980 housing share is the backbone of
CDC/HUD's own lead-risk models, so that pairing is doing real work, not just
padding the input list.

```
address
  │
  ├─▶ Mireye /v1/fetch  ──▶ tract_geoid, water service, nearby legacy
  │                          contamination (superfund/brownfield/RCRA/UST)
  │
  └─▶ Census ACS B25034 ──▶ % of housing built before 1980
                (joined on tract_geoid from Mireye)
                    │
                    ▼
            risk_engine.js  (0-100, fully cited)
                    │
                    ▼
          report.md (ranked, per-address breakdown + sources)
```

## Score (0-100)

| Component | Weight | Source |
|---|---|---|
| Pre-1980 housing share | 0-50 | Census ACS B25034 |
| Nearby legacy contamination (superfund, brownfield, RCRA TSD, open LUST) | 0-30 | Mireye |
| Outside regulated public water service | 0-20 | Mireye |

Bands: 0-30 low, 31-60 moderate, 61-100 priority. Priority addresses get a
recommended action (test-kit + filter dispatch, prioritized outreach), not
just a number, so a health department can act on the output directly.

## Who pays

State and local health departments, EPA Lead and Copper Rule Improvements
compliance teams, and water utilities all currently do this triage by hand
across siloed GIS layers, ACS tables, and county PDFs. This collapses it to
one call.

## Running it

```bash
npm install
cp .env.example .env    # MIREYE_API_TOKEN (free Build tier, code BUILD),
                        # CENSUS_API_KEY (free), LLM_MODEL=openai:gpt-4o
npm start -- --input data/sample-addresses.json --output report.md
```

No token yet? Run with `--demo` (or just omit the token — LeadSentry falls
back automatically) to see the full pipeline against clearly-labeled
illustrative fixtures:

```bash
npm run demo
```

## Limitations / next steps

- Census ACS is tract-level, not parcel-level — a real deployment would
  weight by block group where available.
- The contamination sub-score is a simple distance-threshold rule; a v2
  would fit it against actual blood-lead surveillance data per tract
  (state health departments publish this, unevenly, per county).
- Water-service fields flag *regulatory* gaps (private wells), not
  confirmed lead service lines. EPA's national Lead Service Line Inventory
  (due under the 2024 Lead and Copper Rule Improvements) would sharpen this
  considerably once it's queryable at address level.