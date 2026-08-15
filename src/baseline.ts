import type { MireyeFetchResult } from './mireye/types.js';
import type { ScoreResult } from './scorer.js';
import type { ActionType, Confidence } from './store.js';

export interface BaselineResult {
  action: ActionType;
  confidence: Confidence;
  /** Why the rule baseline picked this action/confidence. */
  rationale: string;
}

/**
 * Pure rule-based baseline. This is the same policy the deterministic offline
 * fallback uses, extracted so the agent run can also compute it after the fact
 * and show where the LLM deviated. The agent never sees this during reasoning —
 * it is computed post-hoc so it cannot anchor the model.
 */
export function ruleBaseline(
  result: MireyeFetchResult,
  score: ScoreResult,
): BaselineResult {
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
    const waterGap = result.fields.within_water_service_area?.value === false;
    action = waterGap ? 'priority_outreach' : 'testkit_dispatch';
    rationale.push(
      waterGap
        ? 'priority band plus a water-service gap argues for door-knock outreach over self-serve kits'
        : 'priority band; household can self-serve with a dispatched test kit and filter',
    );
  } else if (score.band === 'moderate') {
    const lusts = Number(result.fields.open_lust_sites_within_1km_count?.value ?? 0);
    action =
      lusts > 0 || result.fields.within_water_service_area?.value === false
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

  const rationaleText = rationale[0];
  const confidenceText = caveats.length
    ? `confidence capped at ${confidence} because ${caveats.join('; ')}`
    : `high confidence`;

  return { action, confidence, rationale: `${rationaleText}; ${confidenceText}` };
}
