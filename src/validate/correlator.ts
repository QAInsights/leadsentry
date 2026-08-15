import type { NysdohRecord } from './nysdohClient.js';
import type { TractAssessment } from '../zip/zipTriage.js';

export interface ZipRiskSummary {
  zip: string;
  /** Highest tract score in the ZIP. */
  maxScore: number;
  /** Land-share-weighted mean tract score in the ZIP. */
  weightedMeanScore: number;
  /** Share of ZIP land in priority-band tracts. */
  priorityLandShare: number;
  /** Number of tracts screened. */
  tractCount: number;
}

export interface ValidationPoint {
  zip: string;
  leadSentryMax: number;
  leadSentryMean: number;
  priorityLandShare: number;
  nysdohRate: number | null;
  nysdohTests: number;
  nysdohEblls: number | null;
  nysdohYear: number;
}

export interface CorrelationResult {
  metric: string;
  /** Pearson correlation coefficient. */
  pearson: number | null;
  /** Spearman rank correlation coefficient. */
  spearman: number | null;
  /** Number of ZIPs included in the comparison. */
  n: number;
}

export interface ValidationResult {
  /** One row per ZIP that had both LeadSentry and NYSDOH data. */
  points: ValidationPoint[];
  correlations: CorrelationResult[];
  /** Zips screened by LeadSentry but absent from NYSDOH. */
  missingFromNysdoh: string[];
  /** Zips in NYSDOH but not yet screened by LeadSentry (should not happen in normal flow). */
  missingFromLeadSentry: string[];
}

export function aggregateZipScore(zip: string, tracts: TractAssessment[]): ZipRiskSummary {
  if (tracts.length === 0) {
    return { zip, maxScore: 0, weightedMeanScore: 0, priorityLandShare: 0, tractCount: 0 };
  }

  const maxScore = Math.max(...tracts.map((t) => t.score.score));

  const totalLandShare = tracts.reduce((s, t) => s + t.zipTract.zipLandShare, 0);
  const weightedMeanScore =
    totalLandShare > 0
      ? tracts.reduce((s, t) => s + t.score.score * t.zipTract.zipLandShare, 0) / totalLandShare
      : 0;

  const priorityLandShare = tracts
    .filter((t) => t.score.band === 'priority')
    .reduce((s, t) => s + t.zipTract.zipLandShare, 0);

  return { zip, maxScore, weightedMeanScore, priorityLandShare, tractCount: tracts.length };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], m: number): number {
  const n = values.length;
  if (n < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

function ranks(values: number[]): number[] {
  const sorted = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v);
  const result = new Array<number>(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    // Handle ties: average rank for equal values.
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
    const rank = (i + j) / 2 + 1; // 1-indexed average rank
    for (let k = i; k <= j; k++) {
      result[sorted[k].i] = rank;
    }
    i = j + 1;
  }
  return result;
}

function pearson(x: number[], y: number[]): number | null {
  if (x.length < 2 || x.length !== y.length) return null;
  const mx = mean(x);
  const my = mean(y);
  if (mx === null || my === null) return null;

  const sx = stdDev(x, mx);
  const sy = stdDev(y, my);
  if (sx === 0 || sy === 0) return null;

  let cov = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i] - mx) * (y[i] - my);
  }
  cov /= x.length - 1;
  return cov / (sx * sy);
}

function spearman(x: number[], y: number[]): number | null {
  if (x.length < 2 || x.length !== y.length) return null;
  return pearson(ranks(x), ranks(y));
}

function computeCorrelation(points: ValidationPoint[], metric: 'leadSentryMax' | 'leadSentryMean'): CorrelationResult {
  const paired = points.filter((p) => p.nysdohRate !== null);
  const x = paired.map((p) => p[metric]);
  const y = paired.map((p) => p.nysdohRate!);
  return {
    metric: metric === 'leadSentryMax' ? 'Max tract score' : 'Land-weighted mean score',
    pearson: pearson(x, y),
    spearman: spearman(x, y),
    n: paired.length,
  };
}

export function correlate(
  zipSummaries: ZipRiskSummary[],
  nysdoh: Map<string, NysdohRecord>,
): ValidationResult {
  const byZip = new Map(zipSummaries.map((s) => [s.zip, s]));
  const points: ValidationPoint[] = [];
  const missingFromNysdoh: string[] = [];

  for (const summary of zipSummaries) {
    const record = nysdoh.get(summary.zip);
    if (!record) {
      missingFromNysdoh.push(summary.zip);
      continue;
    }
    points.push({
      zip: summary.zip,
      leadSentryMax: summary.maxScore,
      leadSentryMean: summary.weightedMeanScore,
      priorityLandShare: summary.priorityLandShare,
      nysdohRate: record.ratePer1000,
      nysdohTests: record.tests,
      nysdohEblls: record.totalEblls,
      nysdohYear: record.year,
    });
  }

  const nysdohZips = new Set(nysdoh.keys());
  const missingFromLeadSentry = [...nysdohZips].filter((z) => !byZip.has(z));

  points.sort((a, b) => b.leadSentryMax - a.leadSentryMax);

  return {
    points,
    correlations: [
      computeCorrelation(points, 'leadSentryMax'),
      computeCorrelation(points, 'leadSentryMean'),
    ],
    missingFromNysdoh,
    missingFromLeadSentry,
  };
}
