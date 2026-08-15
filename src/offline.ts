import type { MireyeClient } from './mireye/index.js';
import { LEADSENTRY_FIELDS } from './mireye/index.js';
import type { CensusClient } from './census.js';
import { scoreAddress } from './scorer.js';
import { toScorerInput, tractGeoidOf } from './extract.js';
import { AssessmentStore, type ActionType, type Confidence } from './store.js';
import { writeAction } from './actions.js';
import { ruleBaseline } from './baseline.js';

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

    const baseline = ruleBaseline(result, score);
    const { action, confidence } = baseline;

    const drivers = score.components
      .filter((c) => c.points > 0)
      .map((c) => c.reason);
    const reasoning = [
      `Score ${score.score}/100 (${score.band}). Main drivers: ${drivers.join('; ') || 'none'}.`,
      baseline.rationale,
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
      baseline,
    };
    const file = await writeAction(assessment, action);
    store.upsert({ ...assessment, actionFile: file });
  }
}
