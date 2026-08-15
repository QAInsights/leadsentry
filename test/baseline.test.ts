import { describe, it, expect } from 'vitest';
import { ruleBaseline } from '../src/baseline.js';
import type { MireyeFetchResult } from '../src/mireye/types.js';
import type { ScoreResult } from '../src/scorer.js';

function makeResult(partial: Partial<MireyeFetchResult> = {}): MireyeFetchResult {
  return {
    normalizedAddress: '123 Test St',
    lat: 42.9,
    lng: -78.9,
    parcelGrade: true,
    fields: {},
    ...partial,
  } as MireyeFetchResult;
}

function makeScore(
  band: 'low' | 'moderate' | 'priority',
  missingInputs: string[] = [],
  score?: number,
): ScoreResult {
  const scoreValue = score ?? (band === 'priority' ? 72 : band === 'moderate' ? 45 : 9);
  return {
    score: scoreValue,
    band,
    components: [],
    missingInputs,
  };
}

describe('ruleBaseline', () => {
  it('caps confidence to medium for street-centerline geocodes', () => {
    const result = makeResult({ parcelGrade: false, fields: { within_water_service_area: { value: true } } });
    const score = makeScore('priority');
    const b = ruleBaseline(result, score);
    expect(b.confidence).toBe('medium');
    expect(b.rationale).toContain('parcel_grade=false');
  });

  it('downgrades confidence when >30% of expected inputs are null', () => {
    const result = makeResult({
      parcelGrade: true,
      fields: { within_water_service_area: { value: true } },
    });
    const score = makeScore('priority', ['a', 'b', 'c', 'd']); // 4/10 missing
    const b = ruleBaseline(result, score);
    expect(b.confidence).toBe('medium');
    expect(b.rationale).toContain('4');
  });

  it('compound caveats push confidence to low', () => {
    const result = makeResult({
      parcelGrade: false,
      fields: { within_water_service_area: { value: true } },
    });
    const score = makeScore('priority', ['a', 'b', 'c', 'd']); // street-centerline (medium) + >30% null (low)
    const b = ruleBaseline(result, score);
    expect(b.confidence).toBe('low');
  });

  it('priority + water gap => priority_outreach', () => {
    const result = makeResult({
      parcelGrade: true,
      fields: { within_water_service_area: { value: false } },
    });
    const score = makeScore('priority');
    const b = ruleBaseline(result, score);
    expect(b.action).toBe('priority_outreach');
  });

  it('priority + no water gap => testkit_dispatch', () => {
    const result = makeResult({
      parcelGrade: true,
      fields: { within_water_service_area: { value: true } },
    });
    const score = makeScore('priority');
    const b = ruleBaseline(result, score);
    expect(b.action).toBe('testkit_dispatch');
  });

  it('moderate + open LUST => testkit_dispatch', () => {
    const result = makeResult({
      parcelGrade: true,
      fields: {
        within_water_service_area: { value: true },
        open_lust_sites_within_1km_count: { value: 2 },
      },
    });
    const score = makeScore('moderate');
    const b = ruleBaseline(result, score);
    expect(b.action).toBe('testkit_dispatch');
  });

  it('moderate + no red flag => monitoring_list', () => {
    const result = makeResult({
      parcelGrade: true,
      fields: { within_water_service_area: { value: true } },
    });
    const score = makeScore('moderate');
    const b = ruleBaseline(result, score);
    expect(b.action).toBe('monitoring_list');
  });

  it('low band => none', () => {
    const result = makeResult({
      parcelGrade: true,
      fields: { within_water_service_area: { value: true } },
    });
    const score = makeScore('low');
    const b = ruleBaseline(result, score);
    expect(b.action).toBe('none');
  });
});
