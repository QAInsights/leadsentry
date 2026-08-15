import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAddressActions } from '../src/actions.js';
import { AssessmentStore, type Assessment } from '../src/store.js';
import { scoreAddress, type ScorerInput } from '../src/scorer.js';
import type { MireyeFetchResult } from '../src/mireye/types.js';

const TEST_DIR = join('test-tmp-actions');

function fakeFetch(fields: Record<string, unknown>): MireyeFetchResult {
  return {
    address: 'test',
    lat: 42.9,
    lng: -78.9,
    parcelGrade: true,
    normalizedAddress: 'normalized',
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, source: 'test', fetched_at: 'now' }]),
    ),
    partialFailures: [],
  };
}

function makeAssessment(overrides: Partial<Assessment> = {}): Assessment {
  const baselineInput: ScorerInput = {
    pre1980Share: 0.9,
    nearestSuperfundM: 500,
    superfundCount8km: 2,
    nearestBrownfieldM: 300,
    brownfieldCount8km: 5,
    nearestRcraTsdM: 1000,
    rcraTsdCount8km: 1,
    openLustCount1km: 2,
    nearestUstM: 200,
    withinWaterServiceArea: false,
    domesticWellDensityClass: 'High',
  };
  const score = scoreAddress(baselineInput);
  return {
    address: '436 Test St, Buffalo, NY 14213',
    resolvedAddress: '436 Test St, Buffalo, NY 14213',
    lat: 42.9279,
    lng: -78.8795,
    parcelGrade: true,
    tractGeoid: '36029006500',
    mireye: fakeFetch({}),
    census: {
      tractGeoid: '36029006500',
      totalUnits: 2140,
      pre1980Units: 2012,
      pre1980Share: 0.9,
      sourceUrl: 'test',
      fetchedAt: 'now',
      illustrative: false,
    },
    score,
    agentReasoning: 'Test reasoning for the assessment.',
    confidence: 'high',
    action: 'priority_outreach',
    actionFile: 'actions/test.md',
    fieldRequestFiled: false,
    ...overrides,
  };
}

describe('writeAddressActions', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('writes CSV, GeoJSON, and operator-checklist', async () => {
    const store = new AssessmentStore();
    store.upsert(makeAssessment());
    store.upsert(
      makeAssessment({
        address: '12 Rural Rd, NY 14001',
        action: 'none',
        confidence: 'high',
        score: scoreAddress({
          pre1980Share: 0.1,
          nearestSuperfundM: 10000,
          superfundCount8km: 0,
          nearestBrownfieldM: 10000,
          brownfieldCount8km: 0,
          nearestRcraTsdM: 10000,
          rcraTsdCount8km: 0,
          openLustCount1km: 0,
          nearestUstM: 10000,
          withinWaterServiceArea: true,
          domesticWellDensityClass: 'Very Low',
        }),
      }),
    );

    const dir = await writeAddressActions(store, TEST_DIR);
    expect(dir).toBe(TEST_DIR);

    const csv = await readFile(join(TEST_DIR, 'address-actions.csv'), 'utf8');
    const header = csv.split('\n')[0];
    expect(header).toContain('address');
    expect(header).toContain('lat');
    expect(header).toContain('lng');
    expect(header).toContain('score');
    expect(header).toContain('band');
    expect(header).toContain('action');
    expect(header).toContain('pre1980_share_pct');
    expect(header).toContain('contamination_pts');
    expect(header).toContain('water_gap_pts');
    // Two data rows
    const dataRows = csv.trim().split('\n').slice(1);
    expect(dataRows.length).toBe(2);

    const geojson = JSON.parse(await readFile(join(TEST_DIR, 'address-points.geojson'), 'utf8'));
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features.length).toBe(2);
    expect(geojson.features[0].geometry.type).toBe('Point');
    expect(geojson.features[0].geometry.coordinates).toEqual([-78.8795, 42.9279]);
    expect(geojson.features[0].properties.score).toBeGreaterThan(0);
    expect(geojson.features[0].properties.band).toBe('priority');
    expect(geojson.features[0].properties.action).toBe('priority_outreach');

    const checklist = await readFile(join(TEST_DIR, 'operator-checklist.md'), 'utf8');
    expect(checklist).toContain('Operator Checklist');
    expect(checklist).toContain('Canvass first');
    expect(checklist).toContain('Tally');
    expect(checklist).toContain('address-actions.csv');
    expect(checklist).toContain('address-points.geojson');
  });

  it('skips features with null coordinates in GeoJSON', async () => {
    const store = new AssessmentStore();
    store.upsert(makeAssessment({ lat: null, lng: null }));
    await writeAddressActions(store, TEST_DIR);

    const geojson = JSON.parse(await readFile(join(TEST_DIR, 'address-points.geojson'), 'utf8'));
    expect(geojson.features.length).toBe(0);
  });

  it('handles empty store gracefully', async () => {
    const store = new AssessmentStore();
    const dir = await writeAddressActions(store, TEST_DIR);
    expect(dir).toBe(TEST_DIR);
  });

  it('flags street-centerline geocodes in the checklist', async () => {
    const store = new AssessmentStore();
    store.upsert(makeAssessment({ parcelGrade: false, confidence: 'medium' }));
    await writeAddressActions(store, TEST_DIR);

    const checklist = await readFile(join(TEST_DIR, 'operator-checklist.md'), 'utf8');
    expect(checklist).toContain('street centerline');
    expect(checklist).toContain('Data-quality caveats');
  });

  it('flags field requests in the checklist', async () => {
    const store = new AssessmentStore();
    store.upsert(makeAssessment({ fieldRequestFiled: true }));
    await writeAddressActions(store, TEST_DIR);

    const checklist = await readFile(join(TEST_DIR, 'operator-checklist.md'), 'utf8');
    expect(checklist).toContain('Field requests filed');
  });

  it('CSV escapes commas and quotes in addresses', async () => {
    const store = new AssessmentStore();
    store.upsert(makeAssessment({ address: '123 Main St, "Suite 4", Buffalo, NY' }));
    await writeAddressActions(store, TEST_DIR);

    const csv = await readFile(join(TEST_DIR, 'address-actions.csv'), 'utf8');
    const firstDataRow = csv.split('\n')[1];
    expect(firstDataRow).toContain('"123 Main St, ""Suite 4"", Buffalo, NY"');
  });
});
