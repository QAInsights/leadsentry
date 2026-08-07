import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TractAssessment } from './zipTriage.js';

export type TractActionTier = 'canvass' | 'mailer' | 'monitor';

interface TractAction {
  tract: TractAssessment;
  tier: TractActionTier;
  budgetSharePct: number;
  rationale: string;
}

const SIGNIFICANT_SHARE = 0.1; // >=10% of ZIP land

function assignTier(t: TractAssessment): { tier: TractActionTier; rationale: string } {
  const share = t.zipTract.zipLandShare;
  const waterGap = t.score.components.find((c) => c.name === 'water_service_gap')?.points ?? 0;
  const housingOnly =
    t.score.components.filter((c) => c.points > 0).length === 1 &&
    t.score.components.some((c) => c.name === 'pre_1980_housing_share' && c.points > 0);

  if (t.score.band === 'priority') {
    return share >= SIGNIFICANT_SHARE
      ? { tier: 'canvass', rationale: `priority band on ${(share * 100).toFixed(0)}% of ZIP land` }
      : { tier: 'mailer', rationale: 'priority band but sliver land share — mailers before door-knocks' };
  }
  if (t.score.band === 'moderate') {
    if (waterGap >= 15) {
      return { tier: 'canvass', rationale: 'large water-service gap (private wells) — address-actionable even at moderate band' };
    }
    if (housingOnly) {
      return { tier: 'mailer', rationale: 'score leans on tract-level pre-1980 share alone — needs parcel-level corroboration before canvass spend' };
    }
    return share >= SIGNIFICANT_SHARE
      ? { tier: 'mailer', rationale: `moderate band on ${(share * 100).toFixed(0)}% of ZIP land` }
      : { tier: 'monitor', rationale: 'moderate band on a sliver of the ZIP' };
  }
  return { tier: 'monitor', rationale: 'low band — no spend this cycle' };
}

/**
 * Turns a ranked tract list into executable artifacts under actions/zip-<zip>/:
 *   tract-actions.csv     — Excel/ArcGIS-ready, one row per tract
 *   tract-points.geojson  — drops straight into QGIS/ArcGIS
 *   operator-checklist.md — concrete next steps, including what to do when
 *                           the screen comes back mostly low-risk
 */
export async function writeZipActions(
  zip: string,
  tracts: TractAssessment[],
  actionsDir = join('actions', `zip-${zip}`),
): Promise<string> {
  const actions: TractAction[] = tracts.map((tract) => {
    const { tier, rationale } = assignTier(tract);
    return { tract, tier, budgetSharePct: 0, rationale };
  });

  // Budget split: canvass tracts weigh 3x mailer tracts; monitor gets nothing.
  const weights: number[] = actions.map((a) => (a.tier === 'canvass' ? 3 : a.tier === 'mailer' ? 1 : 0));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  actions.forEach((a, i) => {
    a.budgetSharePct = totalWeight > 0 ? Math.round((weights[i] / totalWeight) * 100) : 0;
  });

  await mkdir(actionsDir, { recursive: true });

  // --- CSV -----------------------------------------------------------------
  const csvRows = actions.map((a) => {
    const t = a.tract;
    const pre = t.census ? (t.census.pre1980Share * 100).toFixed(1) : '';
    return [
      t.zipTract.tractGeoid,
      `"${t.point.name.replace(/"/g, '""')}"`,
      t.score.score,
      t.score.band,
      (t.zipTract.zipLandShare * 100).toFixed(1),
      (t.zipTract.tractLandShare * 100).toFixed(1),
      pre,
      a.tier,
      a.budgetSharePct,
      t.point.lat,
      t.point.lng,
      `"${a.rationale.replace(/"/g, '""')}"`,
    ].join(',');
  });
  await writeFile(
    join(actionsDir, 'tract-actions.csv'),
    'tract_geoid,name,score,band,pct_of_zip_land,pct_of_tract_in_zip,pre1980_share_pct,action_tier,budget_share_pct,lat,lng,rationale\n' +
      csvRows.join('\n') +
      '\n',
  );

  // --- GeoJSON ---------------------------------------------------------------
  const geojson = {
    type: 'FeatureCollection',
    features: actions.map((a) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.tract.point.lng, a.tract.point.lat] },
      properties: {
        tract_geoid: a.tract.zipTract.tractGeoid,
        name: a.tract.point.name,
        score: a.tract.score.score,
        band: a.tract.score.band,
        pct_of_zip_land: +(a.tract.zipTract.zipLandShare * 100).toFixed(1),
        pre1980_share_pct: a.tract.census ? +(a.tract.census.pre1980Share * 100).toFixed(1) : null,
        action_tier: a.tier,
        budget_share_pct: a.budgetSharePct,
      },
    })),
  };
  await writeFile(join(actionsDir, 'tract-points.geojson'), JSON.stringify(geojson, null, 2));

  // --- Operator checklist ----------------------------------------------------
  const canvass = actions.filter((a) => a.tier === 'canvass');
  const mailers = actions.filter((a) => a.tier === 'mailer');
  const allLow = tracts.every((t) => t.score.band === 'low');
  const waterGapTracts = actions.filter(
    (a) => (a.tract.score.components.find((c) => c.name === 'water_service_gap')?.points ?? 0) >= 15,
  );

  const lines: string[] = [
    `# Operator Checklist — ZIP ${zip}`,
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} from the tract screening. Concrete next`,
    'steps, in order. Files referenced live in this directory.',
    '',
  ];

  if (allLow) {
    lines.push(
      '## This ZIP screened low-risk — that is a result, not a dead end',
      '',
      '1. **Document the negative screen.** Attach `tract-actions.csv` and the ZIP report to the',
      '   program file — funded lead programs must show *why* a ZIP was deprioritized.',
      '2. **Reallocate the canvassing budget** to the next-highest-scoring ZIP in the county.',
      '3. **Set a re-screen cadence**: rerun this screen annually, or immediately if new',
      '   contamination sites open (Mireye fields are timestamped — the report shows data age).',
      '',
    );
  }

  if (canvass.length > 0) {
    lines.push('## Canvass first (door-to-door / test-kit saturation)', '');
    for (const a of canvass) {
      const pre = a.tract.census ? `${(a.tract.census.pre1980Share * 100).toFixed(0)}% pre-1980` : 'n/a';
      lines.push(
        `- **Tract ${a.tract.zipTract.tractGeoid}** (${pre}, ${a.budgetSharePct}% of budget) — ${a.rationale}.`,
      );
    }
    lines.push(
      '',
      'Get the address list for these tracts from the county parcel viewer (or an existing',
      'program list), save it as a JSON array, then run stage 2:',
      '',
      '```bash',
      `npm start -- --input data/tract-addresses.json --output report.md`,
      '```',
      '',
      'Stage 2 scores each address and writes outreach letters + a test-kit dispatch list.',
      '',
    );
  }

  if (mailers.length > 0) {
    lines.push('## Targeted outreach (mailers / clinic referrals)', '');
    for (const a of mailers) {
      lines.push(`- **Tract ${a.tract.zipTract.tractGeoid}** (${a.budgetSharePct}% of budget) — ${a.rationale}.`);
    }
    lines.push('');
  }

  if (waterGapTracts.length > 0) {
    lines.push('## Water-service gaps — validate before anything else', '');
    for (const a of waterGapTracts) {
      lines.push(
        `- Tract ${a.tract.zipTract.tractGeoid}: households outside mapped community water service`,
        '  are likely on private wells (no federal lead oversight). Cross-check with the county',
        '  health district well permit records, then offer well-water lead tests there first.',
      );
    }
    lines.push('');
  }

  lines.push(
    '## Every ZIP, every run',
    '',
    '- Import `tract-points.geojson` into QGIS/ArcGIS to see the ranking on the map.',
    '- Hand `tract-actions.csv` to whoever owns the budget — it is the spend plan.',
    '- The agent narrative (if generated) is in the ZIP report under "Canvassing plan".',
  );

  await writeFile(join(actionsDir, 'operator-checklist.md'), lines.join('\n') + '\n');
  return actionsDir;
}
