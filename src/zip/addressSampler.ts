import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Free, no-key address sampling for ZIP-mode deep-dives.
 *
 *   1. Census TIGERweb ArcGIS REST → tract polygon (GeoJSON)
 *   2. OpenStreetMap Overpass API → addresses with addr:housenumber inside polygon
 *   3. deterministic spread sample → N addresses to deep-triage
 *
 * Deep-dive is additive: if either service is unavailable, the sampler logs the
 * reason and returns an empty list. The ZIP report then says "stage 2 skipped —
 * use the county parcel list" instead of failing.
 */

export interface SampledAddress {
  /** Display address; may be later re-geocoded by Mireye. */
  address: string;
  lat: number;
  lng: number;
  /** OSM source attribution for the report. */
  source: string;
}

export interface AddressSamplerContext {
  /** ZIP code (used to fill missing city/state in OSM addresses). */
  zip?: string;
  /** Starting index into the sorted address list, for spreading samples across
   * multiple target tracts in the same deep-dive run. */
  offset?: number;
}

export interface AddressSampler {
  sampleAddresses(
    tractGeoid: string,
    n: number,
    context?: AddressSamplerContext,
  ): Promise<{
    addresses: SampledAddress[];
    /** Human-readable provenance line for the report. */
    provenance: string;
    /** Null on success; describes why sampling was skipped. */
    skippedReason: string | null;
  }>;
}

type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

// TIGERweb "Census 2020" service / "Census Tracts" layer — verified live.
const TIGERWEB_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/10';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Number of decimal places for polygon lat/lng in the Overpass `poly:` filter.
// 5 decimals ≈ 1 m, fine for tract-scale address queries.
const COORD_DECIMALS = 5;

function toFixedDecimals(n: number, decimals = COORD_DECIMALS): string {
  return n.toFixed(decimals);
}

/**
 * Disk cache with no TTL. Census tract polygons and OSM address lists are
 * stable for the duration of a campaign; delete `data/cache/tract-*.json`
 * if you want to force a refresh.
 *
 * `shouldCache` lets callers avoid caching transiently-empty results (e.g.
 * an Overpass query that returned no addresses), so a future rerun can try
 * again without manual cache deletion.
 */
async function readOrWrite<T>(
  path: string,
  fetcher: () => Promise<T>,
  shouldCache: (data: T) => boolean = () => true,
): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    const data = await fetcher();
    if (shouldCache(data)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(data, null, 2));
    }
    return data;
  }
}

interface PolygonResult {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: number[][][] };
    properties: { GEOID: string; NAME: string };
  }>;
}

export class OsmAddressSampler implements AddressSampler {
  constructor(private readonly cacheDir = join('data', 'cache')) {}

  private cachePath(name: string): string {
    return join(this.cacheDir, name);
  }

  async tractPolygon(tractGeoid: string): Promise<[number, number][] | null> {
    const data = await readOrWrite<PolygonResult>(
      this.cachePath(`tract-poly-${tractGeoid}.json`),
      async () => {
        // maxAllowableOffset simplifies the polygon; 0.0001 deg is ~10m,
        // coarse enough for Overpass but still faithful to the tract shape.
        const url =
          `${TIGERWEB_URL}/query?where=GEOID=%27${encodeURIComponent(tractGeoid)}%27` +
          `&outFields=GEOID,NAME&returnGeometry=true` +
          `&maxAllowableOffset=0.0001&f=geojson`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`TIGERweb failed (${res.status}) for tract ${tractGeoid}`);
        return (await res.json()) as PolygonResult;
      },
    );
    const feature = data.features[0];
    if (!feature) return null;
    const ring = feature.geometry.coordinates[0];
    // Downsample exterior ring if still > 300 vertices (Overpass poly limit).
    if (ring.length > 300) {
      const step = Math.ceil(ring.length / 300);
      return ring.filter((_, i) => i % step === 0).map(([lng, lat]) => [lat, lng]);
    }
    return ring.map(([lng, lat]) => [lat, lng]);
  }

  private overpassQuery(poly: [number, number][]): string {
    const polyStr = poly.map(([lat, lng]) => `${toFixedDecimals(lat)} ${toFixedDecimals(lng)}`).join(' ');
    return `[out:json][timeout:45];
(
  node["addr:housenumber"](poly:"${polyStr}");
  way["addr:housenumber"](poly:"${polyStr}");
);
out center;`;
  }

  async overpassAddresses(poly: [number, number][]): Promise<SampledAddress[]> {
    const query = this.overpassQuery(poly);
    let lastErr: Error | null = null;
    for (const endpoint of OVERPASS_URLS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          headers: {
            accept: '*/*',
            'user-agent': 'LeadSentry/0.1 (openstreetmap.org/copyright)',
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 429) throw new Error('Overpass rate-limited (429)');
        if (!res.ok) throw new Error(`Overpass failed (${res.status})`);
        const data = (await res.json()) as {
          elements: Array<{
            type: 'node' | 'way' | 'relation';
            lat?: number;
            lon?: number;
            center?: { lat: number; lon: number };
            tags?: Record<string, string>;
          }>;
        };
        return this.parseElements(data.elements);
      } catch (err) {
        lastErr = err as Error;
        console.log(`[sampler] Overpass endpoint ${endpoint} failed: ${lastErr.message}; trying fallback`);
      }
    }
    throw lastErr ?? new Error('All Overpass endpoints failed');
  }

  private parseElements(elements: OverpassElement[]): SampledAddress[] {
    const seen = new Set<string>();
    const out: SampledAddress[] = [];
    for (const e of elements) {
      const tags = e.tags ?? {};
      const street = (tags['addr:street'] ?? '').trim();
      const housenumber = (tags['addr:housenumber'] ?? '').trim();
      if (!street || !housenumber) continue;

      let city = (tags['addr:city'] ?? '').trim();
      let state = (tags['addr:state'] ?? '').trim();
      const postcode = (tags['addr:postcode'] ?? '').trim();

      // Normalize common casing quirks in OSM (e.g. "Main ST" -> "Main st").
      const streetNorm = street.replace(/\b(ave|st|dr|rd|blvd|ln|ct|pl|ter|pkwy|cir)\b\.?/gi, (m) =>
        m.toLowerCase(),
      );

      const address = `${housenumber} ${streetNorm}, ${city}${state ? `, ${state}` : ''}${
        postcode ? ` ${postcode}` : ''
      }`.replace(/, $/, '').replace(/, ,/g, ',');

      const lat = e.center?.lat ?? e.lat;
      const lng = e.center?.lon ?? e.lon;
      if (lat == null || lng == null) continue;

      const key = `${lat.toFixed(4)},${lng.toFixed(4)}-${address}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        address,
        lat,
        lng,
        source: 'OpenStreetMap contributors (ODbL)',
      });
    }
    return out;
  }

  async sampleAddresses(
    tractGeoid: string,
    n: number,
    context?: AddressSamplerContext,
  ): Promise<{
    addresses: SampledAddress[];
    provenance: string;
    skippedReason: string | null;
  }> {
    const poly = await this.tractPolygon(tractGeoid);
    if (!poly) {
      return {
        addresses: [],
        provenance: '',
        skippedReason: `TIGERweb has no 2020 census-tract polygon for ${tractGeoid}`,
      };
    }

    const all = await readOrWrite<SampledAddress[]>(
      this.cachePath(`tract-addrs-${tractGeoid}.json`),
      async () => this.overpassAddresses(poly),
      // Don't cache an empty OSM result; a later run may have new data.
      (data) => Array.isArray(data) && data.length > 0,
    );

    // Qualify with the provided ZIP regardless of cache hit — harmless if the
    // address already has a zip code, useful if it was cached before a context
    // was supplied (e.g. demo/fallback re-runs).
    const qualified = context?.zip
      ? all.map((a) => ({ ...a, address: this.qualifyAddress(a.address, context.zip!) }))
      : all;

    if (qualified.length === 0) {
      return {
        addresses: [],
        provenance: 'OpenStreetMap contributors (ODbL)',
        skippedReason: `No OSM addresses found in tract ${tractGeoid}`,
      };
    }

    // Deterministic spread sample: sort by lat, then take every k-th point,
    // starting from `offset` so multiple tracts in the same run don't all pick
    // the same first address.
    const sorted = [...qualified].sort((a, b) => a.lat - b.lat);
    const step = Math.max(1, Math.floor(sorted.length / n));
    const offset = context?.offset ?? 0;
    const sampled: SampledAddress[] = [];
    const seen = new Set<string>();
    const key = (a: SampledAddress) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)}-${a.address}`;

    for (let i = offset; i < sorted.length && sampled.length < n; i += step) {
      const a = sorted[i];
      if (!seen.has(key(a))) {
        seen.add(key(a));
        sampled.push(a);
      }
    }
    // If we ended up short because of rounding, back-fill from the end.
    if (sampled.length < n) {
      for (let i = sorted.length - 1; i >= 0 && sampled.length < n; i--) {
        const a = sorted[i];
        if (!seen.has(key(a))) {
          seen.add(key(a));
          sampled.push(a);
        }
      }
    }

    return {
      addresses: sampled,
      provenance: 'OpenStreetMap contributors (ODbL)',
      skippedReason: null,
    };
  }

  private qualifyAddress(address: string, zip: string): string {
    if (/\b\d{5}(-\d{4})?\b/.test(address)) return address;
    return `${address} ${zip}`.replace(/, $/, '').trim();
  }
}
