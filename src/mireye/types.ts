/** Provenance metadata Mireye attaches to every field value (passthrough). */
export interface FieldProvenance {
  source?: string;
  source_url?: string;
  fetched_at?: string;
  confidence?: string;
  [key: string]: unknown;
}

export interface FetchedField extends FieldProvenance {
  value: unknown;
}

export interface GeocodeInfo {
  parcel_grade?: boolean;
  accuracy_type?: string;
  normalized_address?: string;
  precision_note?: string | null;
  [key: string]: unknown;
}

export interface MireyeFetchResult {
  address: string;
  lat: number | null;
  lng: number | null;
  parcelGrade: boolean | null;
  normalizedAddress: string | null;
  fields: Record<string, FetchedField>;
  partialFailures: unknown[];
}

/** The 13 catalog fields LeadSentry triages on (verified against catalog v0.14.0). */
export const LEADSENTRY_FIELDS = [
  'tract_geoid',
  'within_water_service_area',
  'water_system_name',
  'domestic_well_households_per_km2',
  'domestic_well_household_density_class',
  'nearest_superfund_distance_m',
  'superfund_sites_within_radius_count',
  'nearest_brownfield_distance_m',
  'brownfields_within_radius_count',
  'nearest_rcra_tsd_distance_m',
  'rcra_tsd_facilities_within_radius_count',
  'open_lust_sites_within_1km_count',
  'nearest_ust_facility_distance_m',
] as const;

export interface MireyeClient {
  readonly mode: 'mcp' | 'rest' | 'demo';
  fetchForAddress(address: string, fields?: readonly string[]): Promise<MireyeFetchResult>;
  /** Same field set at a bare coordinate (used for tract-level sampling in ZIP mode). */
  fetchForPoint(lat: number, lng: number, fields?: readonly string[]): Promise<MireyeFetchResult>;
  /** Plain-language field request (the /v1/field-requests flourish). Null when unsupported. */
  requestField(question: string, lat: number, lng: number): Promise<unknown>;
  close(): Promise<void>;
}
