import { writeFile } from 'node:fs/promises';
import type { ValidationResult, ValidationPoint } from './correlator.js';

function fmt(n: number | null, digits = 2): string {
  if (n === null || Number.isNaN(n)) return 'n/a';
  return n.toFixed(digits);
}

function fmtInt(n: number | null): string {
  if (n === null || Number.isNaN(n)) return 'n/a';
  return String(Math.round(n));
}

export function renderValidationMarkdown(result: ValidationResult): string {
  const corRows = result.correlations
    .map((c) => `| ${c.metric} | ${fmt(c.pearson)} | ${fmt(c.spearman)} | ${c.n} |`)
    .join('\n');

  const pointRows = result.points
    .map(
      (p) =>
        `| ${p.zip} | ${Math.round(p.leadSentryMax)} | ${Math.round(p.leadSentryMean)} | ${(p.priorityLandShare * 100).toFixed(0)}% | ${fmt(p.nysdohRate, 1)} | ${fmtInt(p.nysdohEblls)} | ${fmtInt(p.nysdohTests)} | ${p.nysdohYear} |`,
    )
    .join('\n');

  const interpretation = interpretCorrelations(result.correlations);

  const missing =
    result.missingFromNysdoh.length > 0
      ? `## Zips screened but not found in NYSDOH data\n\n${result.missingFromNysdoh.map((z) => `- ${z}`).join('\n')}\n\n`
      : '';

  return `# LeadSentry Ground-Truth Validation

LeadSentry's ZIP-mode risk scores are compared against real childhood blood-lead
outcomes from the NYSDOH Childhood Blood Lead Testing dataset. For each ZIP, the
correlation uses the **max tract score** (worst tract in the ZIP) and the
**land-weighted mean tract score** (average risk weighted by how much of the ZIP
each tract covers).

## Correlation with observed EBLL rate

| LeadSentry metric | Pearson r | Spearman ρ | ZIPs with data |
|---|---|---|---|
${corRows}

${interpretation}

## By ZIP

| ZIP | Max score | Mean score | Priority land | NYSDOH rate / 1,000 | EBLLs | Tests | Year |
|---|---|---|---|---|---|---|---|
${pointRows}

${missing}Source: [NYSDOH Childhood Blood Lead Testing and Elevated Incidence by Zip Code](https://health.data.ny.gov/Health/Childhood-Blood-Lead-Testing-and-Elevated-Incidenc/d54z-enu8).
`;
}

export async function writeValidationReport(result: ValidationResult, outputPath: string): Promise<void> {
  await writeFile(outputPath, renderValidationMarkdown(result));
}

export function renderZipValidationSection(point: ValidationPoint | null): string {
  if (!point) {
    return `## NYSDOH validation

No NYSDOH blood-lead incidence data was found for this ZIP in the latest
available year. The LeadSentry score is still valid, but it could not be
compared with observed outcomes.
`;
  }

  const rate = point.nysdohRate !== null ? `${point.nysdohRate.toFixed(1)} per 1,000 tested` : 'not reported';
  const note =
    point.nysdohRate === null
      ? 'The ZIP had tests but no reported elevated BLLs in that year.'
      : `This ZIP was screened by the state in ${point.nysdohYear} and had ${point.nysdohEblls ?? 0} confirmed elevated BLLs across ${point.nysdohTests} tests.`;

  return `## NYSDOH validation

- **LeadSentry max tract score:** ${Math.round(point.leadSentryMax)}/100
- **LeadSentry land-weighted mean score:** ${Math.round(point.leadSentryMean)}/100
- **NYSDOH observed elevated-BLL rate:** ${rate} (${point.nysdohYear}, ${point.nysdohTests} tests)
- ${note}

Run the multi-ZIP validation study to see the correlation between LeadSentry
scores and observed blood-lead rates across the county.
`;
}

function interpretCorrelations(correlations: ValidationResult['correlations']): string {
  const lines: string[] = [];
  for (const c of correlations) {
    const r = c.pearson;
    if (r === null) {
      lines.push(`- **${c.metric}:** not enough data to compute a correlation.`);
      continue;
    }
    const strength =
      Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.4 ? 'moderate' : 'weak';
    const direction = r > 0 ? 'positive' : 'negative';
    lines.push(
      `- **${c.metric}:** ${strength} ${direction} correlation (Pearson r = ${r.toFixed(2)}). ` +
        `${strength === 'strong' ? 'LeadSentry ranking is materially aligned with actual blood-lead outcomes.' : 'More ZIPs or a refined model would improve this relationship.'}`,
    );
  }
  return lines.join('\n');
}
