import type { CensusClient, TractHousingAge } from '../census.js';
import type { MireyeClient, MireyeFetchResult } from '../mireye/types.js';
import type { TractFileResolver, TractPoint, ZipTract } from '../zip/tractFiles.js';
import type { AddressSampler, SampledAddress } from '../zip/addressSampler.js';

/**
 * Clearly-labeled illustrative fixtures so the full pipeline runs without
 * tokens. Addresses are real Buffalo, NY streets (oldest big-city housing
 * stock in the US); all data values below are INVENTED for demonstration.
 */

interface FixtureProfile {
  lat: number;
  lng: number;
  tractGeoid: string;
  parcelGrade: boolean;
  values: Record<string, unknown>;
}

const PROFILES: Record<string, FixtureProfile> = {
  '436 massachusetts ave, buffalo, ny 14213': {
    lat: 42.9279,
    lng: -78.8795,
    tractGeoid: '36029006500',
    parcelGrade: true,
    values: {
      within_water_service_area: true,
      water_system_name: 'Buffalo Water Authority (illustrative)',
      domestic_well_households_per_km2: 0.4,
      domestic_well_household_density_class: 'Very Low',
      nearest_superfund_distance_m: 6100,
      superfund_sites_within_radius_count: 1,
      nearest_brownfield_distance_m: 420,
      brownfields_within_radius_count: 6,
      nearest_rcra_tsd_distance_m: 2400,
      rcra_tsd_facilities_within_radius_count: 2,
      open_lust_sites_within_1km_count: 3,
      nearest_ust_facility_distance_m: 180,
    },
  },
  '789 grant st, buffalo, ny 14213': {
    lat: 42.9186,
    lng: -78.8887,
    tractGeoid: '36029006601',
    parcelGrade: true,
    values: {
      within_water_service_area: true,
      water_system_name: 'Buffalo Water Authority (illustrative)',
      domestic_well_households_per_km2: 0.3,
      domestic_well_household_density_class: 'Very Low',
      nearest_superfund_distance_m: 7200,
      superfund_sites_within_radius_count: 1,
      nearest_brownfield_distance_m: 950,
      brownfields_within_radius_count: 4,
      nearest_rcra_tsd_distance_m: 3900,
      rcra_tsd_facilities_within_radius_count: 1,
      open_lust_sites_within_1km_count: 1,
      nearest_ust_facility_distance_m: 610,
    },
  },
  '12 example hollow rd, rural, ny 14001': {
    lat: 42.7661,
    lng: -78.6108,
    tractGeoid: '36029014902',
    parcelGrade: false,
    values: {
      within_water_service_area: false,
      water_system_name: null,
      domestic_well_households_per_km2: 41.2,
      domestic_well_household_density_class: 'High',
      nearest_superfund_distance_m: null,
      superfund_sites_within_radius_count: 0,
      nearest_brownfield_distance_m: null,
      brownfields_within_radius_count: 0,
      nearest_rcra_tsd_distance_m: null,
      rcra_tsd_facilities_within_radius_count: 0,
      open_lust_sites_within_1km_count: 0,
      nearest_ust_facility_distance_m: 5400,
    },
  },
  '2214 genesee st, buffalo, ny 14211': {
    lat: 42.9093,
    lng: -78.8182,
    tractGeoid: '36029003300',
    parcelGrade: true,
    values: {
      within_water_service_area: true,
      water_system_name: 'Buffalo Water Authority (illustrative)',
      domestic_well_households_per_km2: 0.5,
      domestic_well_household_density_class: 'Very Low',
      nearest_superfund_distance_m: 380,
      superfund_sites_within_radius_count: 2,
      nearest_brownfield_distance_m: 260,
      brownfields_within_radius_count: 9,
      nearest_rcra_tsd_distance_m: 480,
      rcra_tsd_facilities_within_radius_count: 3,
      open_lust_sites_within_1km_count: 4,
      nearest_ust_facility_distance_m: 95,
    },
  },
  '35 maple view ln, amherst, ny 14221': {
    lat: 43.0209,
    lng: -78.7566,
    tractGeoid: '36029009411',
    parcelGrade: true,
    values: {
      within_water_service_area: true,
      water_system_name: 'Erie County Water Authority (illustrative)',
      domestic_well_households_per_km2: 1.1,
      domestic_well_household_density_class: 'Low',
      nearest_superfund_distance_m: null,
      superfund_sites_within_radius_count: 0,
      nearest_brownfield_distance_m: 6800,
      brownfields_within_radius_count: 1,
      nearest_rcra_tsd_distance_m: null,
      rcra_tsd_facilities_within_radius_count: 0,
      open_lust_sites_within_1km_count: 0,
      nearest_ust_facility_distance_m: 2300,
    },
  },
};

const TRACT_HOUSING: Record<string, { total: number; pre1980: number }> = {
  '36029006500': { total: 2140, pre1980: 2012 }, // 94.0% — West Side, pre-war stock
  '36029006601': { total: 1890, pre1980: 1683 }, // 89.0%
  '36029017100': { total: 2073, pre1980: 1462 }, // 70.5% — Grant St corridor
  '36029014902': { total: 1450, pre1980: 1021 }, // 70.4% — rural tract, older farmhouses
  '36029003300': { total: 2310, pre1980: 2241 }, // 97.0% — East Side, oldest stock
  '36029009411': { total: 2680, pre1980: 268 }, // 10.0% — 1990s suburb
};

// Demo ZIP mode: 14213 -> three tracts with invented internal points + values.
const DEMO_ZIP_TRACTS: Record<string, ZipTract[]> = {
  '14213': [
    { tractGeoid: '36029006500', zipLandShare: 0.45, tractLandShare: 0.92 },
    { tractGeoid: '36029006601', zipLandShare: 0.38, tractLandShare: 0.88 },
    { tractGeoid: '36029017100', zipLandShare: 0.17, tractLandShare: 0.61 },
  ],
};

const DEMO_TRACT_POINTS: Record<string, TractPoint> = {
  '36029006500': { tractGeoid: '36029006500', name: 'Census Tract 65', lat: 42.928, lng: -78.8795 },
  '36029006601': { tractGeoid: '36029006601', name: 'Census Tract 66.01', lat: 42.9186, lng: -78.8887 },
  '36029017100': { tractGeoid: '36029017100', name: 'Census Tract 171', lat: 42.9346, lng: -78.8887 },
};

// Point-sampled field values per demo tract (illustrative).
const DEMO_TRACT_VALUES: Record<string, Record<string, unknown>> = {
  '36029006500': {
    within_water_service_area: true,
    water_system_name: 'Buffalo Water Authority (illustrative)',
    domestic_well_households_per_km2: 0.4,
    domestic_well_household_density_class: 'Very Low',
    nearest_superfund_distance_m: 6100,
    superfund_sites_within_radius_count: 1,
    nearest_brownfield_distance_m: 420,
    brownfields_within_radius_count: 6,
    nearest_rcra_tsd_distance_m: 2400,
    rcra_tsd_facilities_within_radius_count: 2,
    open_lust_sites_within_1km_count: 3,
    nearest_ust_facility_distance_m: 180,
  },
  '36029006601': {
    within_water_service_area: true,
    water_system_name: 'Buffalo Water Authority (illustrative)',
    domestic_well_households_per_km2: 0.3,
    domestic_well_household_density_class: 'Very Low',
    nearest_superfund_distance_m: 7200,
    superfund_sites_within_radius_count: 1,
    nearest_brownfield_distance_m: 950,
    brownfields_within_radius_count: 4,
    nearest_rcra_tsd_distance_m: 3900,
    rcra_tsd_facilities_within_radius_count: 1,
    open_lust_sites_within_1km_count: 1,
    nearest_ust_facility_distance_m: 610,
  },
  '36029017100': {
    within_water_service_area: true,
    water_system_name: 'Buffalo Water Authority (illustrative)',
    domestic_well_households_per_km2: 0.6,
    domestic_well_household_density_class: 'Very Low',
    nearest_superfund_distance_m: 1055,
    superfund_sites_within_radius_count: 1,
    nearest_brownfield_distance_m: 1285,
    brownfields_within_radius_count: 3,
    nearest_rcra_tsd_distance_m: 7682,
    rcra_tsd_facilities_within_radius_count: 1,
    open_lust_sites_within_1km_count: 0,
    nearest_ust_facility_distance_m: 920,
  },
};

/** demo coordinate -> tract geoid, so fetchForPoint can find the fixture. */
const POINT_TO_TRACT = new Map(
  Object.values(DEMO_TRACT_POINTS).map((p) => [`${p.lat},${p.lng}`, p.tractGeoid]),
);

function normalize(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class DemoMireyeClient implements MireyeClient {
  readonly mode = 'demo' as const;

  async fetchForAddress(address: string): Promise<MireyeFetchResult> {
    const profile = PROFILES[normalize(address)];
    if (!profile) {
      throw new Error(
        `No demo fixture for "${address}". Demo fixtures exist only for the addresses in data/sample-addresses.json.`,
      );
    }
    const fetchedAt = new Date().toISOString();
    const fields = Object.fromEntries(
      Object.entries({ tract_geoid: profile.tractGeoid, ...profile.values }).map(([k, v]) => [
        k,
        { value: v, source: 'ILLUSTRATIVE_FIXTURE', fetched_at: fetchedAt, confidence: 'demo' },
      ]),
    );
    return {
      address,
      lat: profile.lat,
      lng: profile.lng,
      parcelGrade: profile.parcelGrade,
      normalizedAddress: address,
      fields,
      partialFailures: [],
    };
  }

  async fetchForPoint(lat: number, lng: number): Promise<MireyeFetchResult> {
    const tractGeoid = POINT_TO_TRACT.get(`${lat},${lng}`);
    const values = tractGeoid ? DEMO_TRACT_VALUES[tractGeoid] : undefined;
    if (!tractGeoid || !values) {
      throw new Error(`No demo point fixture for ${lat},${lng}`);
    }
    const fetchedAt = new Date().toISOString();
    const fields = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        { value: v, source: 'ILLUSTRATIVE_FIXTURE', fetched_at: fetchedAt, confidence: 'demo' },
      ]),
    );
    return {
      address: `${lat},${lng}`,
      lat,
      lng,
      parcelGrade: null,
      normalizedAddress: null,
      fields,
      partialFailures: [],
    };
  }

  async requestField(question: string, _lat: number, _lng: number): Promise<unknown> {
    return {
      status: 'demo_simulated',
      question,
      note: 'Illustrative only — with a real token this files POST /v1/field-requests.',
    };
  }

  async close(): Promise<void> {}
}

export class DemoTractFiles implements TractFileResolver {
  async tractsForZip(zip: string): Promise<ZipTract[]> {
    const tracts = DEMO_ZIP_TRACTS[zip];
    if (!tracts) throw new Error(`No demo ZIP fixture for "${zip}" (only 14213)`);
    return tracts;
  }

  async tractPoint(tractGeoid: string): Promise<TractPoint> {
    const point = DEMO_TRACT_POINTS[tractGeoid];
    if (!point) throw new Error(`No demo tract point for ${tractGeoid}`);
    return point;
  }
}

export class DemoCensusClient implements CensusClient {
  async pre1980Share(tractGeoid: string): Promise<TractHousingAge> {
    const t = TRACT_HOUSING[tractGeoid];
    if (!t) throw new Error(`No demo census fixture for tract ${tractGeoid}`);
    return {
      tractGeoid,
      totalUnits: t.total,
      pre1980Units: t.pre1980,
      pre1980Share: t.pre1980 / t.total,
      sourceUrl: 'ILLUSTRATIVE_FIXTURE (shape matches ACS 2023 5-year B25034)',
      fetchedAt: new Date().toISOString(),
      illustrative: true,
    };
  }
}

export const DEMO_ADDRESSES = Object.keys(PROFILES).map(
  (a) => a.replace(/\b\w/g, (c) => c.toUpperCase()),
);

// Demo address sampler: returns a few of the existing fixture addresses for the
// top demo tract, so ZIP + --deep mode runs end-to-end tokenless.
export class DemoAddressSampler implements AddressSampler {
  async sampleAddresses(
    tractGeoid: string,
    n: number,
    context?: { zip?: string; offset?: number },
  ): Promise<{ addresses: SampledAddress[]; provenance: string; skippedReason: string | null }> {
    const topTracts = ['36029006500', '36029006601', '36029017100'];
    if (!topTracts.includes(tractGeoid)) {
      return {
        addresses: [],
        provenance: 'ILLUSTRATIVE_FIXTURE',
        skippedReason: `No demo address fixture for tract ${tractGeoid} (only 14213 tracts)`,
      };
    }
    const all: SampledAddress[] = DEMO_ADDRESSES.map((a) => {
      const profile = PROFILES[normalize(a)];
      return {
        address: a,
        lat: profile.lat,
        lng: profile.lng,
        source: 'ILLUSTRATIVE_FIXTURE',
      };
    });
    // Deterministic spread sample, same logic as OsmAddressSampler.
    const sorted = [...all].sort((x, y) => x.lat - y.lat);
    const step = Math.max(1, Math.floor(sorted.length / n));
    const offset = context?.offset ?? 0;
    const sampled: SampledAddress[] = [];
    for (let i = offset; i < sorted.length && sampled.length < n; i += step) {
      sampled.push(sorted[i]);
    }
    if (sampled.length < n) {
      for (let i = sorted.length - 1; i >= 0 && sampled.length < n; i--) {
        const a = sorted[i];
        if (!sampled.includes(a)) sampled.push(a);
      }
    }
    return { addresses: sampled, provenance: 'ILLUSTRATIVE_FIXTURE', skippedReason: null };
  }
}
