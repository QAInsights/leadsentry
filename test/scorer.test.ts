import { describe, it, expect } from 'vitest';
import { scoreAddress, type ScorerInput } from '../src/scorer.js';
import { toScorerInput } from '../src/extract.js';
import type { MireyeFetchResult } from '../src/mireye/types.js';

/** A clean baseline with all fields present and zero-risk — mutate from here. */
function baseline(overrides: Partial<ScorerInput> = {}): ScorerInput {
  return {
    pre1980Share: 0,
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
    ...overrides,
  };
}

describe('scoreAddress — housing age (0-50)', () => {
  it('scores 0 for 0% pre-1980', () => {
    const r = scoreAddress(baseline({ pre1980Share: 0 }));
    const housing = r.components.find((c) => c.name === 'pre_1980_housing_share')!;
    expect(housing.points).toBe(0);
  });

  it('scores 50 for 100% pre-1980', () => {
    const r = scoreAddress(baseline({ pre1980Share: 1 }));
    const housing = r.components.find((c) => c.name === 'pre_1980_housing_share')!;
    expect(housing.points).toBe(50);
  });

  it('rounds to the nearest point', () => {
    const r = scoreAddress(baseline({ pre1980Share: 0.331 }));
    const housing = r.components.find((c) => c.name === 'pre_1980_housing_share')!;
    expect(housing.points).toBe(17); // 0.331 * 50 = 16.55 -> 17
  });

  it('tracks missing census data', () => {
    const r = scoreAddress(baseline({ pre1980Share: null }));
    expect(r.missingInputs).toContain('census_pre1980_share');
    expect(r.components.find((c) => c.name === 'pre_1980_housing_share')).toBeUndefined();
  });
});

describe('scoreAddress — legacy contamination (0-30)', () => {
  it('scores Superfund by distance bands', () => {
    const close = scoreAddress(baseline({ nearestSuperfundM: 300, superfundCount8km: 1 }));
    const mid = scoreAddress(baseline({ nearestSuperfundM: 1500, superfundCount8km: 1 }));
    const far = scoreAddress(baseline({ nearestSuperfundM: 5000, superfundCount8km: 1 }));
    const contam = (r: ReturnType<typeof scoreAddress>) =>
      r.components.find((c) => c.name === 'legacy_contamination')!.points;
    expect(contam(close)).toBeGreaterThanOrEqual(contam(mid));
    expect(contam(mid)).toBeGreaterThan(contam(far));
  });

  it('boosts Superfund score for multiple sites', () => {
    const one = scoreAddress(baseline({ nearestSuperfundM: 1500, superfundCount8km: 1 }));
    const many = scoreAddress(baseline({ nearestSuperfundM: 1500, superfundCount8km: 6 }));
    const contam = (r: ReturnType<typeof scoreAddress>) =>
      r.components.find((c) => c.name === 'legacy_contamination')!.points;
    expect(contam(many)).toBeGreaterThan(contam(one));
  });

  it('caps Superfund at 10 even with high count', () => {
    const two = scoreAddress(baseline({ nearestSuperfundM: 300, superfundCount8km: 2 }));
    const many = scoreAddress(baseline({ nearestSuperfundM: 300, superfundCount8km: 20 }));
    // 10 (distance) + 1 (count boost at 2 sites) -> capped at 10 per source.
    // A count of 20 should not exceed the same cap.
    const twoContam = two.components.find((c) => c.name === 'legacy_contamination')!;
    const manyContam = many.components.find((c) => c.name === 'legacy_contamination')!;
    expect(twoContam.points).toBe(10);
    expect(manyContam.points).toBe(10);
  });

  it('scores UST distance as a contamination signal', () => {
    const close = scoreAddress(baseline({ nearestUstM: 300 }));
    const far = scoreAddress(baseline({ nearestUstM: 10000 }));
    const contam = (r: ReturnType<typeof scoreAddress>) =>
      r.components.find((c) => c.name === 'legacy_contamination')!.points;
    expect(contam(close)).toBeGreaterThan(contam(far));
  });

  it('scores open LUST count', () => {
    const none = scoreAddress(baseline({ openLustCount1km: 0 }));
    const some = scoreAddress(baseline({ openLustCount1km: 2 }));
    const many = scoreAddress(baseline({ openLustCount1km: 5 }));
    const contam = (r: ReturnType<typeof scoreAddress>) =>
      r.components.find((c) => c.name === 'legacy_contamination')!.points;
    expect(contam(some)).toBeGreaterThan(contam(none));
    expect(contam(many)).toBeGreaterThan(contam(some));
    // LUST caps at 6 points (3+ sites -> 6)
    const lustCap = scoreAddress(baseline({ openLustCount1km: 10 }));
    expect(contam(lustCap) - contam(none)).toBeLessThanOrEqual(6);
  });

  it('caps total contamination at 30', () => {
    const r = scoreAddress(
      baseline({
        nearestSuperfundM: 100,
        superfundCount8km: 10,
        nearestBrownfieldM: 100,
        brownfieldCount8km: 20,
        nearestRcraTsdM: 100,
        rcraTsdCount8km: 5,
        openLustCount1km: 10,
        nearestUstM: 100,
      }),
    );
    const contam = r.components.find((c) => c.name === 'legacy_contamination')!;
    expect(contam.points).toBe(30);
    expect(contam.maxPoints).toBe(30);
  });

  it('tracks missing contamination fields', () => {
    const r = scoreAddress(
      baseline({
        nearestSuperfundM: null,
        superfundCount8km: null,
        nearestBrownfieldM: null,
        brownfieldCount8km: null,
        nearestRcraTsdM: null,
        rcraTsdCount8km: null,
        openLustCount1km: null,
        nearestUstM: null,
      }),
    );
    expect(r.missingInputs).toContain('nearest_superfund_distance_m');
    expect(r.missingInputs).toContain('superfund_sites_within_radius_count');
    expect(r.missingInputs).toContain('open_lust_sites_within_1km_count');
    expect(r.missingInputs).toContain('nearest_ust_facility_distance_m');
  });
});

describe('scoreAddress — water service gap (0-20)', () => {
  it('scores 0 when inside a water service area with low well density', () => {
    const r = scoreAddress(baseline({ withinWaterServiceArea: true, domesticWellDensityClass: 'Very Low' }));
    const water = r.components.find((c) => c.name === 'water_service_gap')!;
    expect(water.points).toBe(0);
  });

  it('scores 15 when outside water service area', () => {
    const r = scoreAddress(baseline({ withinWaterServiceArea: false, domesticWellDensityClass: 'Very Low' }));
    const water = r.components.find((c) => c.name === 'water_service_gap')!;
    expect(water.points).toBe(15);
  });

  it('adds 5 for high domestic well density', () => {
    const r = scoreAddress(baseline({ withinWaterServiceArea: false, domesticWellDensityClass: 'High' }));
    const water = r.components.find((c) => c.name === 'water_service_gap')!;
    expect(water.points).toBe(20); // 15 + 5, capped at 20
  });

  it('matches "very high" density class case-insensitively', () => {
    const r = scoreAddress(baseline({ withinWaterServiceArea: true, domesticWellDensityClass: 'VERY HIGH' }));
    const water = r.components.find((c) => c.name === 'water_service_gap')!;
    expect(water.points).toBe(5);
  });

  it('tracks missing water fields', () => {
    const r = scoreAddress(baseline({ withinWaterServiceArea: null, domesticWellDensityClass: null }));
    expect(r.missingInputs).toContain('within_water_service_area');
    expect(r.missingInputs).toContain('domestic_well_household_density_class');
  });
});

describe('scoreAddress — bands', () => {
  it('assigns low band for score <= 30', () => {
    const r = scoreAddress(baseline({ pre1980Share: 0.5 })); // 25 housing + 0 else
    expect(r.score).toBe(25);
    expect(r.band).toBe('low');
  });

  it('assigns moderate band for 31-60', () => {
    const r = scoreAddress(baseline({ pre1980Share: 0.8 })); // 40 housing
    expect(r.score).toBe(40);
    expect(r.band).toBe('moderate');
  });

  it('assigns priority band for 61-100', () => {
    const r = scoreAddress(
      baseline({
        pre1980Share: 1, // 50
        withinWaterServiceArea: false, // 15
        domesticWellDensityClass: 'High', // +5 = 20 water
      }),
    );
    expect(r.score).toBe(70);
    expect(r.band).toBe('priority');
  });

  it('assigns low at exactly 30', () => {
    const r = scoreAddress(baseline({ pre1980Share: 0.6 })); // 30
    expect(r.band).toBe('low');
  });

  it('assigns moderate at exactly 60', () => {
    const r = scoreAddress(
      baseline({
        pre1980Share: 0.8, // 40
        withinWaterServiceArea: false, // 15
        domesticWellDensityClass: 'Low', // 0
      }),
    );
    expect(r.score).toBe(55); // 40 + 15 = 55, moderate
    expect(r.band).toBe('moderate');
  });
});

describe('scoreAddress — caps and structure', () => {
  it('caps total score at 100', () => {
    const r = scoreAddress(
      baseline({
        pre1980Share: 1,
        nearestSuperfundM: 100,
        superfundCount8km: 10,
        nearestBrownfieldM: 100,
        brownfieldCount8km: 20,
        nearestRcraTsdM: 100,
        rcraTsdCount8km: 5,
        openLustCount1km: 10,
        nearestUstM: 100,
        withinWaterServiceArea: false,
        domesticWellDensityClass: 'High',
      }),
    );
    expect(r.score).toBe(100);
  });

  it('every component cites a source', () => {
    const r = scoreAddress(baseline({ pre1980Share: 0.5 }));
    for (const c of r.components) {
      expect(c.source.length).toBeGreaterThan(0);
      expect(c.maxPoints).toBeGreaterThan(0);
    }
  });
});

describe('toScorerInput', () => {
  function fakeFetch(fields: Record<string, unknown>): MireyeFetchResult {
    return {
      address: 'test',
      lat: 0,
      lng: 0,
      parcelGrade: true,
      normalizedAddress: 'test',
      fields: Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          { value: v, source: 'test', fetched_at: 'now' },
        ]),
      ),
      partialFailures: [],
    };
  }

  it('maps all contamination and water fields', () => {
    const result = fakeFetch({
      nearest_superfund_distance_m: 500,
      superfund_sites_within_radius_count: 3,
      nearest_brownfield_distance_m: 1000,
      brownfields_within_radius_count: 5,
      nearest_rcra_tsd_distance_m: 2000,
      rcra_tsd_facilities_within_radius_count: 1,
      open_lust_sites_within_1km_count: 2,
      nearest_ust_facility_distance_m: 300,
      within_water_service_area: false,
      domestic_well_household_density_class: 'High',
    });
    const input = toScorerInput(result, 0.7);
    expect(input.nearestSuperfundM).toBe(500);
    expect(input.superfundCount8km).toBe(3);
    expect(input.nearestUstM).toBe(300);
    expect(input.withinWaterServiceArea).toBe(false);
    expect(input.domesticWellDensityClass).toBe('High');
    expect(input.pre1980Share).toBe(0.7);
  });

  it('treats missing fields as null', () => {
    const result = fakeFetch({});
    const input = toScorerInput(result, null);
    expect(input.nearestSuperfundM).toBeNull();
    expect(input.nearestUstM).toBeNull();
    expect(input.withinWaterServiceArea).toBeNull();
    expect(input.pre1980Share).toBeNull();
  });
});
