/**
 * Deterministic lead-exposure risk rubric. Pure function — the agent calls it
 * as a tool, then reasons around the result (confidence, edge cases, action).
 * Weights follow the plan: housing age 0-50, legacy contamination 0-30,
 * water service gap 0-20. Every sub-score cites its input source.
 */

export interface ScorerInput {
  /** 0..1 share of housing units built before 1980 (Census ACS B25034). */
  pre1980Share: number | null;
  // Mireye fields (null = not returned / failed)
  nearestSuperfundM: number | null;
  superfundCount8km: number | null;
  nearestBrownfieldM: number | null;
  brownfieldCount8km: number | null;
  nearestRcraTsdM: number | null;
  rcraTsdCount8km: number | null;
  openLustCount1km: number | null;
  /** Nearest UST facility (active tanks, not releases — see openLustCount1km for those). */
  nearestUstM: number | null;
  withinWaterServiceArea: boolean | null;
  domesticWellDensityClass: string | null;
}

export interface ScoreComponent {
  name: string;
  points: number;
  maxPoints: number;
  reason: string;
  source: string;
}

export type RiskBand = 'low' | 'moderate' | 'priority';

export interface ScoreResult {
  score: number; // 0..100
  band: RiskBand;
  components: ScoreComponent[];
  /** Catalog fields that came back null — the agent should weigh this for confidence. */
  missingInputs: string[];
}

function distancePoints(distanceM: number | null, bands: [number, number][]): number {
  if (distanceM === null) return 0;
  for (const [withinM, pts] of bands) {
    if (distanceM <= withinM) return pts;
  }
  return 0;
}

export function scoreAddress(input: ScorerInput): ScoreResult {
  const components: ScoreComponent[] = [];
  const missing: string[] = [];

  // --- Housing age (0-50): CDC/HUD lead-risk models' backbone ------------
  if (input.pre1980Share === null) {
    missing.push('census_pre1980_share');
  } else {
    const pts = Math.round(input.pre1980Share * 50);
    components.push({
      name: 'pre_1980_housing_share',
      points: pts,
      maxPoints: 50,
      reason: `${(input.pre1980Share * 100).toFixed(1)}% of tract housing built before 1980 (lead-paint era)`,
      source: 'US Census ACS 5-year, Table B25034 (Year Structure Built)',
    });
  }

  // --- Legacy contamination (0-30) ---------------------------------------
  // Distance is the primary signal; site counts act as a boost (capped per
  // source) so that "one site 1.5km away" and "five sites 1.5km away" are not
  // scored identically. UST distance is included as an active-tank proximity
  // signal (releases are scored separately via openLustCount1km).
  const contamination: ScoreComponent[] = [];

  const pushComponent = (
    name: string,
    value: number | null,
    pts: number,
    reason: string,
    source: string,
    max: number,
  ) => {
    if (value === null) {
      missing.push(name);
      return;
    }
    contamination.push({ name, points: Math.min(pts, max), maxPoints: max, reason, source });
  };

  const countBoost = (count: number | null, thresholds: [number, number][]): number => {
    if (count === null) return 0;
    return thresholds.reduce((b, [at, pts]) => (count >= at ? b + pts : b), 0);
  };

  // Superfund: distance 0-10 + count boost (capped at 10).
  const sfDist = distancePoints(input.nearestSuperfundM, [[500, 10], [2000, 7], [8000, 4]]);
  const sfBoost = countBoost(input.superfundCount8km, [[2, 1], [5, 1]]);
  pushComponent(
    'nearest_superfund_distance_m',
    input.nearestSuperfundM,
    sfDist + sfBoost,
    input.nearestSuperfundM === null
      ? ''
      : `nearest Superfund (EPA SEMS) site ${Math.round(input.nearestSuperfundM)} m away` +
        (input.superfundCount8km ? `; ${input.superfundCount8km} site(s) within 8 km` : ''),
    'EPA SEMS via Mireye',
    10,
  );
  if (input.superfundCount8km === null) missing.push('superfund_sites_within_radius_count');

  // Brownfield: distance 0-8 + count boost (capped at 8).
  const bfDist = distancePoints(input.nearestBrownfieldM, [[500, 8], [2000, 5], [8000, 3]]);
  const bfBoost = countBoost(input.brownfieldCount8km, [[3, 1], [8, 1]]);
  pushComponent(
    'nearest_brownfield_distance_m',
    input.nearestBrownfieldM,
    bfDist + bfBoost,
    input.nearestBrownfieldM === null
      ? ''
      : `nearest brownfield (EPA ACRES) ${Math.round(input.nearestBrownfieldM)} m away` +
        (input.brownfieldCount8km ? `; ${input.brownfieldCount8km} site(s) within 8 km` : ''),
    'EPA ACRES via Mireye',
    8,
  );
  if (input.brownfieldCount8km === null) missing.push('brownfields_within_radius_count');

  // RCRA TSD: distance 0-6 + count boost (capped at 6).
  const rcraDist = distancePoints(input.nearestRcraTsdM, [[500, 6], [2000, 4], [8000, 2]]);
  const rcraBoost = countBoost(input.rcraTsdCount8km, [[2, 1]]);
  pushComponent(
    'nearest_rcra_tsd_distance_m',
    input.nearestRcraTsdM,
    rcraDist + rcraBoost,
    input.nearestRcraTsdM === null
      ? ''
      : `nearest RCRA TSD facility ${Math.round(input.nearestRcraTsdM)} m away` +
        (input.rcraTsdCount8km ? `; ${input.rcraTsdCount8km} facility(ies) within 8 km` : ''),
    'EPA RCRA TSD via Mireye',
    6,
  );
  if (input.rcraTsdCount8km === null) missing.push('rcra_tsd_facilities_within_radius_count');

  // UST (active tanks): distance 0-4.
  const ustDist = distancePoints(input.nearestUstM, [[500, 4], [2000, 2], [8000, 1]]);
  pushComponent(
    'nearest_ust_facility_distance_m',
    input.nearestUstM,
    ustDist,
    input.nearestUstM === null
      ? ''
      : `nearest active underground-storage-tank facility ${Math.round(input.nearestUstM)} m away`,
    'EPA UST Finder via Mireye',
    4,
  );

  if (input.openLustCount1km === null) {
    missing.push('open_lust_sites_within_1km_count');
  } else {
    const lustPts = input.openLustCount1km >= 3 ? 6 : input.openLustCount1km * 2;
    contamination.push({
      name: 'open_lust_sites_within_1km_count',
      points: lustPts,
      maxPoints: 6,
      reason: `${input.openLustCount1km} open leaking-underground-storage-tank release site(s) within 1 km`,
      source: 'EPA UST Finder (releases) via Mireye',
    });
  }

  const rawContamination = contamination.reduce((s, c) => s + c.points, 0);
  const capped = Math.min(30, rawContamination);
  if (contamination.length > 0) {
    components.push({
      name: 'legacy_contamination',
      points: capped,
      maxPoints: 30,
      reason:
        contamination
          .filter((c) => c.points > 0)
          .map((c) => c.reason)
          .join('; ') || 'no legacy contamination signals within screening bands',
      source: contamination
        .filter((c) => c.points > 0)
        .map((c) => c.source)
        .join('; ') || 'EPA SEMS/ACRES/RCRA/UST Finder via Mireye',
    });
  }

  // --- Water service gap (0-20) ------------------------------------------
  let waterPts = 0;
  const waterReasons: string[] = [];
  if (input.withinWaterServiceArea === null) {
    missing.push('within_water_service_area');
  } else if (input.withinWaterServiceArea === false) {
    waterPts += 15;
    waterReasons.push(
      'outside any mapped EPA Community Water System service area — likely private well, no federal lead-in-water oversight',
    );
  } else {
    waterReasons.push('inside a mapped community water system service area (regulated under Lead & Copper Rule)');
  }
  if (input.domesticWellDensityClass === null) {
    missing.push('domestic_well_household_density_class');
  } else if (/high|very high/i.test(input.domesticWellDensityClass)) {
    waterPts += 5;
    waterReasons.push(`domestic-well household density class "${input.domesticWellDensityClass}"`);
  }
  waterPts = Math.min(20, waterPts);
  components.push({
    name: 'water_service_gap',
    points: waterPts,
    maxPoints: 20,
    reason: waterReasons.join('; '),
    source: 'EPA CWS Service Areas V3.0 via Mireye',
  });

  const score = Math.min(100, components.reduce((s, c) => s + c.points, 0));
  const band: RiskBand = score <= 30 ? 'low' : score <= 60 ? 'moderate' : 'priority';
  return { score, band, components, missingInputs: missing };
}
