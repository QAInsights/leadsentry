import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchNysdohRates } from '../src/validate/nysdohClient.js';
import { aggregateZipScore, correlate } from '../src/validate/correlator.js';
import { renderValidationMarkdown, renderZipValidationSection } from '../src/validate/report.js';
import type { TractAssessment } from '../src/zip/zipTriage.js';

function fakeTracts(zip: string, scores: number[], shares: number[]): TractAssessment[] {
  return scores.map((score, i) => ({
    zipTract: { tractGeoid: `tract${i}`, zipLandShare: shares[i], tractLandShare: 1.0 },
    point: { tractGeoid: `tract${i}`, name: `Tract ${i}`, lat: 0, lng: 0 },
    census: null,
    score: {
      score,
      band: score <= 30 ? 'low' : score <= 60 ? 'moderate' : 'priority',
      components: [],
      missingInputs: [],
    },
    provenance: {},
  }));
}

describe('fetchNysdohRates', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('parses NYSDOH Socrata response and selects the latest year with a rate', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { zip: '14213', year: '2010', tests: '104', total_eblls: '9', rate_per_1_000: '87', percent: '0.087' },
        { zip: '14213', year: '2020', tests: '57' },
        { zip: '14201', year: '2019', tests: '45' },
      ],
    } as unknown as Response) as typeof global.fetch;

    const result = await fetchNysdohRates(['14213', '14201']);
    expect(result.size).toBe(2);
    expect(result.get('14213')).toEqual({
      zip: '14213',
      year: 2010,
      tests: 104,
      totalEblls: 9,
      ratePer1000: 87,
      percent: 0.087,
    });
    expect(result.get('14201')).toEqual({
      zip: '14201',
      year: 2019,
      tests: 45,
      totalEblls: null,
      ratePer1000: null,
      percent: null,
    });
  });

  it('returns the latest year when no year has a rate', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ zip: '14213', year: '2023', tests: '63' }],
    } as unknown as Response) as typeof global.fetch;

    const result = await fetchNysdohRates(['14213']);
    expect(result.get('14213')).toEqual({
      zip: '14213',
      year: 2023,
      tests: 63,
      totalEblls: null,
      ratePer1000: null,
      percent: null,
    });
  });

  it('respects a specific year', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ zip: '14213', year: '2020', tests: '57' }],
    } as unknown as Response) as typeof global.fetch;

    const result = await fetchNysdohRates(['14213'], { year: 2020 });
    expect(result.get('14213')?.year).toBe(2020);
  });
});

describe('aggregateZipScore', () => {
  it('computes max, weighted mean, and priority land share', () => {
    const tracts = fakeTracts('14213', [80, 30, 50], [0.5, 0.3, 0.2]);
    const summary = aggregateZipScore('14213', tracts);
    expect(summary.maxScore).toBe(80);
    expect(summary.weightedMeanScore).toBeCloseTo(80 * 0.5 + 30 * 0.3 + 50 * 0.2);
    expect(summary.priorityLandShare).toBe(0.5);
  });
});

describe('correlate', () => {
  it('computes positive Pearson and Spearman when risk and EBLL rate rise together', () => {
    const summaries = [
      aggregateZipScore('A', fakeTracts('A', [30], [1])),
      aggregateZipScore('B', fakeTracts('B', [50], [1])),
      aggregateZipScore('C', fakeTracts('C', [80], [1])),
    ];
    const nysdoh = new Map([
      ['A', { zip: 'A', year: 2020, tests: 100, totalEblls: 1, ratePer1000: 10, percent: 0.01 }],
      ['B', { zip: 'B', year: 2020, tests: 100, totalEblls: 3, ratePer1000: 30, percent: 0.03 }],
      ['C', { zip: 'C', year: 2020, tests: 100, totalEblls: 8, ratePer1000: 80, percent: 0.08 }],
    ]);
    const result = correlate(summaries, nysdoh);
    expect(result.points.length).toBe(3);
    expect(result.missingFromNysdoh).toEqual([]);
    for (const c of result.correlations) {
      expect(c.pearson).toBeGreaterThan(0.95);
      expect(c.spearman).toBe(1);
      expect(c.n).toBe(3);
    }
  });

  it('reports ZIPs missing from NYSDOH', () => {
    const summaries = [aggregateZipScore('A', fakeTracts('A', [50], [1]))];
    const result = correlate(summaries, new Map());
    expect(result.missingFromNysdoh).toEqual(['A']);
    expect(result.points).toEqual([]);
  });
});

describe('renderValidationMarkdown', () => {
  it('renders a correlation table and ZIP rows', () => {
    const result = correlate(
      [
        aggregateZipScore('A', fakeTracts('A', [80], [1])),
        aggregateZipScore('B', fakeTracts('B', [30], [1])),
      ],
      new Map([
        ['A', { zip: 'A', year: 2020, tests: 100, totalEblls: 8, ratePer1000: 80, percent: 0.08 }],
        ['B', { zip: 'B', year: 2020, tests: 100, totalEblls: 1, ratePer1000: 10, percent: 0.01 }],
      ]),
    );
    const md = renderValidationMarkdown(result);
    expect(md).toContain('# LeadSentry Ground-Truth Validation');
    expect(md).toContain('| A | 80 |');
    expect(md).toContain('| B | 30 |');
    expect(md).toContain('Pearson');
  });
});

describe('renderZipValidationSection', () => {
  it('renders the observed EBLL rate when a record exists', () => {
    const point = {
      zip: '14213',
      leadSentryMax: 85,
      leadSentryMean: 60,
      priorityLandShare: 0.83,
      nysdohRate: 87,
      nysdohTests: 104,
      nysdohEblls: 9,
      nysdohYear: 2010,
    };
    const md = renderZipValidationSection(point);
    expect(md).toContain('87.0 per 1,000 tested');
    expect(md).toContain('85/100');
  });

  it('renders a missing-data note when the point is null', () => {
    const md = renderZipValidationSection(null);
    expect(md).toContain('No NYSDOH blood-lead incidence data was found');
  });
});
