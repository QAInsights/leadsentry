import { writeFile } from 'node:fs/promises';
import type { Assessment, AssessmentStore } from './store.js';

const BAND_MARK = { low: 'LOW', moderate: 'MODERATE', priority: 'PRIORITY' } as const;

function citationsBlock(a: Assessment): string {
  const lines: string[] = [];
  if (a.census) {
    lines.push(
      `- Pre-1980 housing share: US Census ACS 2023 5-yr, Table B25034 — ${a.census.pre1980Units}/${a.census.totalUnits} units — ${a.census.sourceUrl} (fetched ${a.census.fetchedAt})${a.census.illustrative ? ' **[ILLUSTRATIVE FIXTURE]**' : ''}`,
    );
  }
  if (a.mireye) {
    const bySource = new Map<string, string[]>();
    for (const [name, f] of Object.entries(a.mireye.fields)) {
      const src = String(f.source ?? 'unknown');
      bySource.set(src, [...(bySource.get(src) ?? []), name]);
    }
    for (const [src, fields] of bySource) {
      const fetchedAt = a.mireye.fields[fields[0]]?.fetched_at ?? 'n/a';
      lines.push(`- ${src} (fetched ${fetchedAt}): ${fields.join(', ')}`);
    }
  }
  return lines.join('\n');
}

/** Compiles the ranked, fully-cited markdown report from recorded assessments. */
export async function writeReport(
  store: AssessmentStore,
  outputPath: string,
  meta: { mode: string; model: string | null },
): Promise<void> {
  const ranked = store.ranked();
  const demo = ranked.some((a) => a.census?.illustrative);

  const summaryRows = ranked
    .map((a) => {
      const band = a.score?.band ?? 'low';
      return `| ${BAND_MARK[band]} | ${a.score?.score ?? 'n/a'} | ${a.address} | ${a.action} | ${a.confidence} |`;
    })
    .join('\n');

  const details = ranked
    .map((a, i) => {
      const band = a.score?.band ?? 'low';
      const compRows =
        a.score?.components
          .map((c) => `| ${c.name} | ${c.points}/${c.maxPoints} | ${c.reason} |`)
          .join('\n') ?? '| (none) | | |';
      return `## ${i + 1}. ${a.address} — ${a.score?.score ?? 'n/a'}/100 [${BAND_MARK[band]}]

- **Resolved to:** ${a.resolvedAddress ?? 'n/a'} (${a.lat ?? '?'}, ${a.lng ?? '?'})${a.parcelGrade === false ? ' — WARNING: street-centerline estimate, not a rooftop match' : ''}
- **Census tract:** ${a.tractGeoid ?? 'n/a'}
- **Confidence:** ${a.confidence}${a.score && a.score.missingInputs.length > 0 ? ` (missing inputs: ${a.score.missingInputs.join(', ')})` : ''}
- **Action:** ${a.action}${a.actionFile ? ` -> \`${a.actionFile}\`` : ''}${a.fieldRequestFiled ? ' — field request filed with Mireye' : ''}

| Component | Points | Basis |
|---|---|---|
${compRows}

**Agent reasoning:**
> ${a.agentReasoning.replace(/\n/g, '\n> ')}

**Citations:**
${citationsBlock(a)}
`;
    })
    .join('\n---\n\n');

  const baselineSection = renderBaselineSection(ranked);

  const report = `# LeadSentry Triage Report

Generated ${new Date().toISOString()} · engine: ${meta.mode} · model: ${meta.model ?? 'n/a'}
${demo ? '\n> **DEMO RUN** — data values are clearly-labeled illustrative fixtures, not real Mireye/Census responses. Set MIREYE_API_TOKEN and CENSUS_API_KEY for live data.\n' : ''}
## Ranked summary

| Band | Score | Address | Action | Confidence |
|---|---|---|---|---|
${summaryRows}

---

${baselineSection}${details}
`;
  await writeFile(outputPath, report);
}

function renderBaselineSection(ranked: Assessment[]): string {
  const withBaseline = ranked.filter((a) => a.baseline);
  if (withBaseline.length === 0) return '';

  const rows = withBaseline
    .map((a) => {
      const b = a.baseline!;
      const verdict = b.action === a.action ? 'agrees' : 'overrode';
      const quote =
        verdict === 'overrode'
          ? `<br>Agent reasoned: "${a.agentReasoning.replace(/"/g, "'")}"`
          : '';
      return `| ${a.address} | ${b.action} | ${a.action} | ${b.confidence} | ${a.confidence} | ${verdict}${quote} |`;
    })
    .join('\n');

  const overrides = withBaseline.filter((a) => a.baseline!.action !== a.action);

  let summary: string;
  if (overrides.length === 0) {
    summary =
      `All ${withBaseline.length} address(es) agree with the rule baseline. ` +
      'The agent added per-address data-quality reasoning and decided whether to file a Mireye field request.';
  } else {
    summary = `${overrides.length}/${withBaseline.length} address(es) the agent overrode the rule baseline. ` +
      `The baseline is the same policy used for offline triage; the deviations below are the agent's value-add.`;
  }

  return `## Agent vs. rule baseline

${summary}

| Address | Baseline action | Agent action | Baseline confidence | Agent confidence | Verdict |
|---|---|---|---|---|---|
${rows}

---

`;
}
