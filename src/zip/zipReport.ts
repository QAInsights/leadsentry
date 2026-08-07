import { writeFile } from 'node:fs/promises';
import type { TractAssessment } from './zipTriage.js';

const BAND_MARK = { low: 'LOW', moderate: 'MODERATE', priority: 'PRIORITY' } as const;

export async function writeZipReport(
  zip: string,
  tracts: TractAssessment[],
  plan: string | null,
  outputPath: string,
  meta: { mode: string; model: string | null },
): Promise<void> {
  const demo = tracts.some((t) => t.census?.illustrative);

  const summaryRows = tracts
    .map((t) => {
      const band = t.score.band;
      const pre = t.census ? `${(t.census.pre1980Share * 100).toFixed(1)}%` : 'n/a';
      return `| ${BAND_MARK[band]} | ${t.score.score} | ${t.zipTract.tractGeoid} | ${t.point.name} | ${(t.zipTract.zipLandShare * 100).toFixed(1)}% | ${pre} |`;
    })
    .join('\n');

  const details = tracts
    .map((t, i) => {
      const compRows = t.score.components
        .map((c) => `| ${c.name} | ${c.points}/${c.maxPoints} | ${c.reason} |`)
        .join('\n');
      const citations: string[] = [];
      if (t.census) {
        citations.push(
          `- Pre-1980 housing: Census ACS 2023 5-yr B25034 — ${t.census.pre1980Units}/${t.census.totalUnits} units — ${t.census.sourceUrl} (fetched ${t.census.fetchedAt})${t.census.illustrative ? ' **[ILLUSTRATIVE FIXTURE]**' : ''}`,
        );
      }
      const bySource = new Map<string, string[]>();
      for (const [field, prov] of Object.entries(t.provenance)) {
        const src = prov.source ?? 'unknown';
        bySource.set(src, [...(bySource.get(src) ?? []), field]);
      }
      for (const [src, fields] of bySource) {
        citations.push(`- ${src}: ${fields.join(', ')}`);
      }
      return `## ${i + 1}. Tract ${t.zipTract.tractGeoid} — ${t.score.score}/100 [${BAND_MARK[t.score.band]}]

- **Name:** ${t.point.name} · **covers ${(t.zipTract.zipLandShare * 100).toFixed(1)}% of ZIP land**, ZIP covers ${(t.zipTract.tractLandShare * 100).toFixed(1)}% of tract
- **Sampled at Census internal point:** ${t.point.lat}, ${t.point.lng}
- **Sampling caveat:** contamination/water fields are point samples at the internal point, not tract-wide coverage — per-address triage (stage 2) resolves this.

| Component | Points | Basis |
|---|---|---|
${compRows}

**Citations:**
${citations.join('\n')}
`;
    })
    .join('\n---\n\n');

  const report = `# LeadSentry ZIP Screening — ${zip}

Generated ${new Date().toISOString()} · engine: ${meta.mode} · model: ${meta.model ?? 'n/a'}
${demo ? '\n> **DEMO RUN** — data values are clearly-labeled illustrative fixtures.\n' : ''}
Stage 1 of the two-stage funnel: every census tract overlapping ZIP ${zip},
scored cheaply (one Mireye point sample + one Census call per tract). The
agent's canvassing plan below says where the expensive per-address stage 2
budget goes.

## Ranked tracts

| Band | Score | Tract GEOID | Name | % of ZIP | Pre-1980 share |
|---|---|---|---|---|---|
${summaryRows}

---

${plan ? `## Canvassing plan (agent)\n\n${plan}\n\n---\n\n` : ''}${details}
`;
  await writeFile(outputPath, report);
}
