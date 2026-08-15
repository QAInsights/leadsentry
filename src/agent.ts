import { generateText, isStepCount, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { MireyeClient } from './mireye/index.js';
import { LEADSENTRY_FIELDS } from './mireye/index.js';
import type { CensusClient } from './census.js';
import { scoreAddress } from './scorer.js';
import { toScorerInput, tractGeoidOf } from './extract.js';
import { AssessmentStore, type ActionType, type Confidence } from './store.js';
import { writeAction } from './actions.js';

const SYSTEM = `You are LeadSentry, a triage officer for a county health department's
childhood lead-exposure prevention program. You decide which addresses get
limited testing resources first.

For EVERY address, follow this exact sequence:
1. Call mireye_fetch with the address to get physical-world facts (census
   tract, legacy contamination proximity, water service status).
2. Call census_pre1980_share with the tract_geoid from step 1 to get the
   tract's pre-1980 housing share (the backbone of CDC/HUD lead-risk models).
3. Call score_address with the address to compute the deterministic risk score.
4. REASON about the result, then call record_assessment with your decision.

Your reasoning must account for data quality:
- parcel_grade=false means the location is a street-centerline estimate, not a
  rooftop match. Parcel-specific distances may describe a neighbouring
  property. Cap confidence at "medium" and say so.
- If more than ~30% of inputs came back null, confidence is at most "medium";
  substantial nulls mean "low".
- The contamination sub-score uses distance thresholds only; it cannot prove
  exposure, only prioritize testing.

Action policy:
- priority band (61-100): choose "priority_outreach" (door-knock + letter) or
  "testkit_dispatch" when the family can self-serve. High contamination +
  pre-war housing + water-service gaps together argue for priority_outreach.
- moderate band (31-60): "monitoring_list" unless a specific red flag (open
  LUSTs within 1 km, outside water service area) argues for "testkit_dispatch".
- low band (0-30): "none".

If a tract has pre-1980 share above 90% but the score relies heavily on that
single tract-level signal (weak parcel-level corroboration), you MAY call
request_year_built_field for that address to ask Mireye to build a parcel-level
year-built field. Do this at most once per run, for the strongest candidate.

Work through every address. Do not skip any. When done, reply with a short
summary of the triage outcome.`;

const ACTION_ENUM = z.enum([
  'priority_outreach',
  'testkit_dispatch',
  'outreach_letter',
  'monitoring_list',
  'none',
]);

const CONFIDENCE_ENUM = z.enum(['high', 'medium', 'low']);

export interface AgentDeps {
  model: LanguageModel;
  mireye: MireyeClient;
  census: CensusClient;
  store: AssessmentStore;
}

export interface AgentRunResult {
  text: string;
  usage: unknown;
}

export async function runAgent(addresses: string[], deps: AgentDeps): Promise<AgentRunResult> {
  const { model, mireye, census, store } = deps;

  const tools = {
    mireye_fetch: tool({
      description:
        'Fetch cited physical-world facts for a US street address from Mireye: census tract GEOID, Superfund/brownfield/RCRA-TSD/open-LUST proximity, community water system coverage, domestic well density. Returns per-field values with source provenance.',
      inputSchema: z.object({
        address: z.string().describe('Full US street address'),
      }),
      execute: async ({ address }) => {
        console.log(`[tool] mireye_fetch ${address}`);
        const result = await mireye.fetchForAddress(address, LEADSENTRY_FIELDS);
        const existing = store.get(address);
        store.upsert({
          address,
          resolvedAddress: result.normalizedAddress,
          lat: result.lat,
          lng: result.lng,
          parcelGrade: result.parcelGrade,
          tractGeoid: tractGeoidOf(result),
          mireye: result,
          census: existing?.census ?? null,
          score: existing?.score ?? null,
          agentReasoning: existing?.agentReasoning ?? '',
          confidence: existing?.confidence ?? 'medium',
          action: existing?.action ?? 'none',
          actionFile: existing?.actionFile ?? null,
          fieldRequestFiled: existing?.fieldRequestFiled ?? false,
        });
        return {
          resolved: {
            normalized_address: result.normalizedAddress,
            lat: result.lat,
            lng: result.lng,
            parcel_grade: result.parcelGrade,
          },
          tract_geoid: tractGeoidOf(result),
          fields: Object.fromEntries(
            Object.entries(result.fields).map(([k, v]) => [k, v.value]),
          ),
          partial_failures: result.partialFailures,
        };
      },
    }),

    census_pre1980_share: tool({
      description:
        'Get the share of housing units built before 1980 (the lead-paint era) for a census tract, from US Census ACS Table B25034. Call once per tract_geoid.',
      inputSchema: z.object({
        tract_geoid: z
          .string()
          .describe('11-digit census tract GEOID returned by mireye_fetch'),
        address: z.string().describe('The address this tract lookup is for'),
      }),
      execute: async ({ tract_geoid, address }) => {
        console.log(`[tool] census_pre1980_share ${tract_geoid} (for ${address})`);
        const tract = await census.pre1980Share(tract_geoid);
        const existing = store.get(address);
        if (existing) store.upsert({ ...existing, census: tract, tractGeoid: tract_geoid });
        return tract;
      },
    }),

    score_address: tool({
      description:
        'Compute the deterministic 0-100 lead-exposure risk score for an address whose mireye_fetch and census data have already been gathered. Returns the score, band (low/moderate/priority), per-component breakdown, and any missing inputs.',
      inputSchema: z.object({
        address: z.string(),
      }),
      execute: async ({ address }) => {
        console.log(`[tool] score_address ${address}`);
        const a = store.get(address);
        if (!a?.mireye) return { error: 'call mireye_fetch for this address first' };
        const score = scoreAddress(
          toScorerInput(a.mireye, a.census?.pre1980Share ?? null),
        );
        store.upsert({ ...a, score });
        return score;
      },
    }),

    record_assessment: tool({
      description:
        'Record your final decision for an address: your reasoning, confidence, and the action to take. This writes the action artifact (outreach letter / dispatch entry).',
      inputSchema: z.object({
        address: z.string(),
        reasoning: z
          .string()
          .min(30)
          .describe('Your reasoning: why this confidence and this action, given the data and its quality'),
        confidence: CONFIDENCE_ENUM,
        action: ACTION_ENUM,
      }),
      execute: async ({ address, reasoning, confidence, action }) => {
        console.log(`[tool] record_assessment ${address} -> ${action} (${confidence})`);
        const a = store.get(address);
        if (!a?.score) {
          console.log(`[tool]   REJECTED: no score yet for "${address}"`);
          return { error: 'call score_address for this address first' };
        }
        // Policy guardrails: the agent decides, but band/action mismatches are
        // rejected so a priority address can never silently get "none".
        if (a.score.band === 'priority' && (action === 'none' || action === 'monitoring_list')) {
          console.log(`[tool]   REJECTED: priority band cannot take action "${action}"`);
          return {
            error: `band is priority (${a.score.score}/100) — action must be "priority_outreach" or "testkit_dispatch". Call record_assessment again with a valid action.`,
          };
        }
        if (a.score.band === 'low' && (action === 'priority_outreach' || action === 'testkit_dispatch')) {
          console.log(`[tool]   REJECTED: low band cannot take action "${action}"`);
          return {
            error: `band is low (${a.score.score}/100) — action must be "none" or "monitoring_list". Call record_assessment again with a valid action.`,
          };
        }
        const updated = { ...a, agentReasoning: reasoning, confidence, action };
        const file = await writeAction(updated, action);
        // Re-read after the await: tool calls in the same step can run
        // concurrently, so merge onto the latest entry to avoid clobbering
        // (e.g. request_year_built_field writing fieldRequestFiled).
        const latest = store.get(address) ?? updated;
        store.upsert({ ...latest, agentReasoning: reasoning, confidence, action, actionFile: file });
        return { recorded: true, action_file: file };
      },
    }),

    request_year_built_field: tool({
      description:
        'File a plain-language request with Mireye to build a parcel-level year-built field for this location (currently absent from the catalog). Use at most once per run, for the strongest candidate where tract-level data is the main risk signal.',
      inputSchema: z.object({
        address: z.string(),
      }),
      execute: async ({ address }) => {
        const a = store.get(address);
        if (!a?.mireye || a.lat === null || a.lng === null) {
          return { error: 'no coordinates for this address yet' };
        }
        console.log(`[tool] request_year_built_field ${address}`);
        const result = await mireye.requestField(
          'year the building at this parcel was built (parcel-level structure age)',
          a.lat,
          a.lng,
        );
        // Re-read after the await — concurrent tool calls may have updated
        // this entry (see record_assessment).
        const latest = store.get(address);
        if (latest) store.upsert({ ...latest, fieldRequestFiled: true });
        return result;
      },
    }),
  };

  // Step budget: each address needs ~4 tool calls (fetch, census, score,
  // record) plus reasoning steps; allow generous headroom for retries, the
  // optional request_year_built_field call, and a final summary. The agent
  // is completion-driven (it must record_assessment for every address), so
  // this is a safety cap, not the expected path length.
  const maxSteps = Math.max(addresses.length * 10 + 16, 40);
  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: `Triage these ${addresses.length} addresses for childhood lead-exposure risk:\n${addresses
      .map((a, i) => `${i + 1}. ${a}`)
      .join('\n')}`,
    tools,
    stopWhen: isStepCount(maxSteps),
  });

  return { text: result.text, usage: result.usage };
}
