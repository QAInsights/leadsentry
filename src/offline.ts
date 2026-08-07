import type { MireyeClient } from './mireye/index.js';
import { LEADSENTRY_FIELDS } from './mireye/index.js';
import type { CensusClient } from './census.js';
import { scoreAddress } from './scorer.js';
import { toScorerInput, tractGeoidOf } from './extract.js';
import { AssessmentStore, type ActionType, type Confidence } from './store.js';
import { writeAction } from './actions.js';

/**
 * Deterministic fallback when no LLM is configured: runs the same pipeline
 * with rule-based reasoning so the demo still produces a complete report.
 * Clearly labeled in the report header as OFFLINE TRIAGE.
 */
export async function triageOffline(
  addresses: string[],
  mireye: MireyeClient,
  census: CensusClient,
  store: AssessmentStore,
): Promise<void> {
  for (const address of addresses) {
    let result;
    try {
      result = await mireye.fetchForAddress(address, LEADSENTRY_FIELDS);
    } catch (err) {
      console.error(
        `[offline] fetch failed for "${address}" (${(err as Error).message.slice(0, 160)}) — skipping`,
      );
      continue;
    }
    const geoid = tractGeoidOf(result);
    const tract = geoid
      ? await census.pre1980Share(geoid).catch((err: Error) => {
          console.error(`[offline] census lookup failed for tract ${geoid}: ${err.message}`);
          return null;
        })
      : null;
    const score = scoreAddress(toScorerInput(result, tract?.pre1980Share ?? null));

    // Rule-based confidence: mirrors the agent's system-prompt policy.
    let confidence: Confidence = 'high';
    const caveats: string[] = [];
    if (result.parcelGrade === false) {
      confidence = 'medium';
      caveats.push(
        'location is a street-centerline estimate (parcel_grade=false), so parcel-level distances may describe a neighbouring property',
      );
    }
    const totalExpected = 10;
    if (score.missingInputs.length > totalExpected * 0.3) {
      confidence = confidence === 'medium' ? 'low' : 'medium';
      caveats.push(`${score.missingInputs.length} inputs returned null`);
    }

    // Rule-based action: mirrors the agent's action policy.
    let action: ActionType = 'none';
    const rationale: string[] = [];
    if (score.band === 'priority') {
      const waterGap =
        result.fields.within_water_service_area?.value === false;
      action = waterGap ? 'priority_outreach' : 'testkit_dispatch';
      rationale.push(
        waterGap
          ? 'priority band plus a water-service gap argues for door-knock outreach over self-serve kits'
          : 'priority band; household can self-serve with a dispatched test kit and filter',
      );
    } else if (score.band === 'moderate') {
      const lusts = Number(result.fields.open_lust_sites_within_1km_count?.value ?? 0);
      action = lusts > 0 || result.fields.within_water_service_area?.value === false
        ? 'testkit_dispatch'
        : 'monitoring_list';
      rationale.push(
        action === 'testkit_dispatch'
          ? 'moderate band with a specific red flag (open LUSTs nearby or outside water service)'
          : 'moderate band without a specific red flag — monitor',
      );
    } else {
      rationale.push('low band — no action warranted');
    }

    const drivers = score.components
      .filter((c) => c.points > 0)
      .map((c) => c.reason);
    const reasoning = [
      `Score ${score.score}/100 (${score.band}). Main drivers: ${drivers.join('; ') || 'none'}.`,
      ...rationale,
      ...(caveats.length ? [`Confidence ${confidence} because ${caveats.join('; ')}.`] : []),
    ].join(' ');

    const assessment = {
      address,
      resolvedAddress: result.normalizedAddress,
      lat: result.lat,
      lng: result.lng,
      parcelGrade: result.parcelGrade,
      tractGeoid: geoid,
      mireye: result,
      census: tract,
      score,
      agentReasoning: reasoning,
      confidence,
      action,
      actionFile: null as string | null,
      fieldRequestFiled: false,
    };
    const file = await writeAction(assessment, action);
    store.upsert({ ...assessment, actionFile: file });
  }
}
