import { generateText, type LanguageModel } from 'ai';
import type { TractAssessment } from './zipTriage.js';

const SYSTEM = `You are LeadSentry, a triage officer for a county health department's
childhood lead-exposure prevention program. You have a ranked list of census
tracts in one ZIP code, each with a 0-100 lead-risk score and its component
breakdown. Per-address testing budgets are limited; tract-level screening is
cheap, per-address canvassing is expensive.

Write a canvassing plan in markdown:
1. **Canvass first** — which tract(s) get door-to-door / test-kit saturation,
   and why (cite the specific score components).
2. **Targeted outreach** — tracts where mailers or clinic referrals suffice.
3. **Monitor only** — tracts that don't justify spend this cycle.
4. **Where to spend the per-address budget** — a concrete recommendation for
   how many addresses to deep-triage in the top tracts, and what address-level
   evidence would change the ranking (e.g. parcel-level year-built, which
   Mireye does not yet have).

Rules:
- Weight a tract's share of the ZIP's land area — a high score on a sliver
  tract matters less for this ZIP's residents.
- Flag any tract where the score leaned on one component (usually the
  tract-level pre-1980 share) as needing parcel-level corroboration.
- Be concrete and brief. Health-department staff will act on this directly.`;

/** Stage 1.5: the agent turns ranked tracts into a canvassing plan. */
export async function planZipCanvassing(
  zip: string,
  tracts: TractAssessment[],
  model: LanguageModel,
): Promise<string> {
  const table = tracts
    .map((t) => {
      const comp = t.score.components.map((c) => `${c.name}=${c.points}/${c.maxPoints}`).join(', ');
      return [
        `tract ${t.zipTract.tractGeoid} (${t.point.name})`,
        `score=${t.score.score} band=${t.score.band}`,
        `zip_land_share=${(t.zipTract.zipLandShare * 100).toFixed(1)}%`,
        `pre1980_share=${t.census ? (t.census.pre1980Share * 100).toFixed(1) + '%' : 'missing'}`,
        `components: ${comp}`,
        t.score.missingInputs.length ? `missing: ${t.score.missingInputs.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
    })
    .join('\n');

  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: `ZIP ${zip}, tracts ranked by lead-risk score:\n${table}`,
  });
  return result.text;
}
