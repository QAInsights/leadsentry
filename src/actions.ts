import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Assessment, AssessmentStore, ActionType, Confidence } from './store.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function slug(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Writes the concrete follow-up artifact an agent decided on:
 * outreach letter, test-kit dispatch entry, or monitoring-list line.
 * Output goes to actions/ so a health department can act on it directly.
 */
export async function writeAction(
  assessment: Assessment,
  action: ActionType,
  actionsDir = 'actions',
): Promise<string | null> {
  if (action === 'none') return null;
  await mkdir(actionsDir, { recursive: true });

  const score = assessment.score?.score ?? 'n/a';
  const band = assessment.score?.band ?? 'unknown';

  if (action === 'outreach_letter' || action === 'priority_outreach') {
    const file = join(actionsDir, `${slug(assessment.address)}.md`);
    const topDrivers =
      assessment.score?.components
        .filter((c) => c.points > 0)
        .map((c) => `- ${c.reason} (${c.points}/${c.maxPoints} pts — ${c.source})`)
        .join('\n') ?? '- (no scored components)';
    const letter = `# ${action === 'priority_outreach' ? 'PRIORITY ' : ''}Lead-Safety Outreach — DRAFT

**To:** Resident, ${assessment.address}
**Risk score:** ${score}/100 (${band})
**Prepared:** ${new Date().toISOString().slice(0, 10)}

Dear Resident,

Our screening program has identified your home as having an elevated risk of
lead exposure${assessment.census ? ` — ${(assessment.census.pre1980Share * 100).toFixed(0)}% of homes in your census tract were built before 1980, when lead paint was still in use` : ''}.
Lead exposure is most dangerous for children under 6 and is entirely
preventable once identified.

**What we are offering, at no cost to you:**
1. A free lead test kit for your home's water and painted surfaces.
2. A free water filter certified for lead removal, if you want one.
3. Information on free blood-lead testing for children under 6.

To schedule, reply to this letter or call the county health department.

---
*Risk factors identified (with sources):*
${topDrivers}
`;
    await writeFile(file, letter);
    return file;
  }

  if (action === 'testkit_dispatch' || action === 'monitoring_list') {
    const file = join(actionsDir, 'dispatch-list.md');
    const line = `| ${assessment.address} | ${score} | ${band} | ${action === 'testkit_dispatch' ? 'test kit + filter' : 'monitor'} | ${assessment.confidence} |\n`;
    if (!(await exists(file))) {
      await writeFile(
        file,
        '# Test-Kit Dispatch & Monitoring List\n\n| Address | Score | Band | Action | Confidence |\n|---|---|---|---|---|\n',
      );
    }
    await appendFile(file, line);
    return file;
  }

  return null;
}

// --- Address-mode summary artifacts (CSV + GeoJSON + operator checklist) -----
// Mirrors the ZIP mode's writeZipActions: after the agent finishes, write
// machine-readable artifacts a health department can hand to a GIS tool or a
// budget owner. The per-address markdown letters above stay as the
// resident-facing output; these are the operator-facing summary.

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function componentPoints(a: Assessment, name: string): number | null {
  return a.score?.components.find((c) => c.name === name)?.points ?? null;
}

/**
 * Writes the three operator-facing summary artifacts for an address-mode run:
 *   address-actions.csv   — Excel/ArcGIS-ready, one row per assessed address
 *   address-points.geojson — drops straight into QGIS/ArcGIS
 *   operator-checklist.md  — concrete next steps, grouped by action tier
 *
 * Call once after the agent + offline completion pass, from the ranked store.
 */
export async function writeAddressActions(
  store: AssessmentStore,
  actionsDir = 'actions',
): Promise<string> {
  const ranked = store.ranked();
  if (ranked.length === 0) return actionsDir;
  await mkdir(actionsDir, { recursive: true });

  // --- CSV -----------------------------------------------------------------
  const csvHeader = [
    'address',
    'resolved_address',
    'lat',
    'lng',
    'parcel_grade',
    'tract_geoid',
    'score',
    'band',
    'action',
    'confidence',
    'baseline_action',
    'agent_overrode',
    'pre1980_share_pct',
    'contamination_pts',
    'water_gap_pts',
    'missing_inputs',
    'field_request_filed',
    'action_file',
  ].join(',');

  const csvRows = ranked.map((a) =>
    [
      csvField(a.address),
      csvField(a.resolvedAddress),
      a.lat ?? '',
      a.lng ?? '',
      a.parcelGrade === null ? '' : a.parcelGrade ? 'true' : 'false',
      csvField(a.tractGeoid),
      a.score?.score ?? '',
      a.score?.band ?? '',
      a.action,
      a.confidence,
      a.baseline?.action ?? '',
      a.baseline && a.baseline.action !== a.action ? 'true' : 'false',
      a.census ? +(a.census.pre1980Share * 100).toFixed(1) : '',
      componentPoints(a, 'legacy_contamination') ?? '',
      componentPoints(a, 'water_service_gap') ?? '',
      csvField(a.score?.missingInputs.join('; ') ?? ''),
      a.fieldRequestFiled ? 'true' : 'false',
      csvField(a.actionFile),
    ].join(','),
  );

  await writeFile(
    join(actionsDir, 'address-actions.csv'),
    csvHeader + '\n' + csvRows.join('\n') + '\n',
  );

  // --- GeoJSON ---------------------------------------------------------------
  const geojson = {
    type: 'FeatureCollection',
    features: ranked
      .filter((a) => a.lat !== null && a.lng !== null)
      .map((a) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [a.lng, a.lat],
        },
        properties: {
          address: a.address,
          resolved_address: a.resolvedAddress,
          score: a.score?.score ?? null,
          band: a.score?.band ?? null,
          action: a.action,
          confidence: a.confidence,
          baseline_action: a.baseline?.action ?? null,
          agent_overrode: a.baseline ? a.baseline.action !== a.action : null,
          tract_geoid: a.tractGeoid,
          parcel_grade: a.parcelGrade,
          pre1980_share_pct: a.census ? +(a.census.pre1980Share * 100).toFixed(1) : null,
          contamination_pts: componentPoints(a, 'legacy_contamination'),
          water_gap_pts: componentPoints(a, 'water_service_gap'),
          missing_inputs: a.score?.missingInputs ?? [],
          field_request_filed: a.fieldRequestFiled,
        },
      })),
  };
  await writeFile(join(actionsDir, 'address-points.geojson'), JSON.stringify(geojson, null, 2));

  // --- Operator checklist ----------------------------------------------------
  const byAction = (action: ActionType) => ranked.filter((a) => a.action === action);
  const byBand = (band: 'low' | 'moderate' | 'priority') =>
    ranked.filter((a) => a.score?.band === band);

  const priority = byAction('priority_outreach');
  const testkits = byAction('testkit_dispatch');
  const letters = byAction('outreach_letter');
  const monitoring = byAction('monitoring_list');
  const none = byAction('none');
  const lowBand = byBand('low');
  const streetCenterline = ranked.filter((a) => a.parcelGrade === false);
  const lowConfidence = ranked.filter((a) => a.confidence === 'low');
  const fieldRequests = ranked.filter((a) => a.fieldRequestFiled);

  const lines: string[] = [
    '# Operator Checklist — Address Triage',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} from ${ranked.length} address assessment(s).`,
    'Concrete next steps, in order. Files referenced live in this directory.',
    '',
    '## Tally',
    '',
    `| Tier | Count |`,
    `|---|---|`,
    `| Priority outreach (door-knock) | ${priority.length} |`,
    `| Test-kit dispatch | ${testkits.length} |`,
    `| Outreach letter | ${letters.length} |`,
    `| Monitoring list | ${monitoring.length} |`,
    `| No action | ${none.length} |`,
    `| **Priority band** | **${byBand('priority').length}** |`,
    `| **Moderate band** | **${byBand('moderate').length}** |`,
    `| **Low band** | **${lowBand.length}** |`,
    '',
  ];

  if (priority.length > 0) {
    lines.push('## Canvass first (door-to-door)', '');
    for (const a of priority) {
      const pre = a.census ? `${(a.census.pre1980Share * 100).toFixed(0)}% pre-1980` : 'n/a';
      lines.push(
        `- **${a.address}** (${a.score?.score}/100, ${pre}, confidence ${a.confidence}) — letter at \`${a.actionFile ?? 'n/a'}\``,
      );
    }
    lines.push('');
  }

  if (testkits.length > 0) {
    lines.push('## Test-kit dispatch (self-serve)', '');
    for (const a of testkits) {
      lines.push(`- **${a.address}** (${a.score?.score}/100, ${a.confidence}) — entry in \`dispatch-list.md\``);
    }
    lines.push('');
  }

  if (letters.length > 0) {
    lines.push('## Outreach letters', '');
    for (const a of letters) {
      lines.push(`- **${a.address}** — \`${a.actionFile ?? 'n/a'}\``);
    }
    lines.push('');
  }

  if (monitoring.length > 0) {
    lines.push('## Monitoring list (re-screen next cycle)', '');
    for (const a of monitoring) {
      lines.push(`- ${a.address} (${a.score?.score}/100, ${a.confidence})`);
    }
    lines.push('');
  }

  if (streetCenterline.length > 0) {
    lines.push(
      '## Data-quality caveats — review before acting',
      '',
      `**${streetCenterline.length} address(es) were geocoded to a street centerline, not a rooftop/parcel.**`,
      'Distances to contamination sites may describe a neighbouring property. Before door-knocking,',
      'confirm the parcel with the county assessor. Affected addresses:',
      '',
      ...streetCenterline.map((a) => `- ${a.address} (confidence ${a.confidence})`),
      '',
    );
  }

  if (lowConfidence.length > 0) {
    lines.push(
      `**${lowConfidence.length} address(es) have low confidence** — re-run with live Mireye + Census keys if this was a demo, or gather parcel-level data before spending.`,
      '',
    );
  }

  if (fieldRequests.length > 0) {
    lines.push(
      '## Field requests filed with Mireye',
      '',
      `The agent filed ${fieldRequests.length} parcel-level year-built field request(s):`,
      '',
      ...fieldRequests.map((a) => `- ${a.address}`),
      '',
      'When Mireye builds that field, re-run this triage — parcel-level structure age will sharpen',
      'the housing-age sub-score beyond the tract-level ACS estimate.',
      '',
    );
  }

  lines.push(
    '## Every run, every time',
    '',
    '- Import `address-points.geojson` into QGIS/ArcGIS to see the ranking on the map.',
    '- Hand `address-actions.csv` to whoever owns the budget — it is the dispatch plan.',
    '- Per-address outreach letters are individual `.md` files in this directory.',
    '- The full ranked report with citations is in the report file passed to `--output`.',
  );

  await writeFile(join(actionsDir, 'operator-checklist.md'), lines.join('\n') + '\n');
  return actionsDir;
}
