import type { MireyeFetchResult } from './mireye/types.js';
import type { ScorerInput } from './scorer.js';

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Maps a Mireye fetch result onto the deterministic scorer's input shape. */
export function toScorerInput(
  result: MireyeFetchResult,
  pre1980Share: number | null,
): ScorerInput {
  const f = result.fields;
  return {
    pre1980Share,
    nearestSuperfundM: num(f.nearest_superfund_distance_m?.value),
    superfundCount8km: num(f.superfund_sites_within_radius_count?.value),
    nearestBrownfieldM: num(f.nearest_brownfield_distance_m?.value),
    brownfieldCount8km: num(f.brownfields_within_radius_count?.value),
    nearestRcraTsdM: num(f.nearest_rcra_tsd_distance_m?.value),
    rcraTsdCount8km: num(f.rcra_tsd_facilities_within_radius_count?.value),
    openLustCount1km: num(f.open_lust_sites_within_1km_count?.value),
    withinWaterServiceArea: bool(f.within_water_service_area?.value),
    domesticWellDensityClass: str(f.domestic_well_household_density_class?.value),
  };
}

export function tractGeoidOf(result: MireyeFetchResult): string | null {
  return str(result.fields.tract_geoid?.value);
}
