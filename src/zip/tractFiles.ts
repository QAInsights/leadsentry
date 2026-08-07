import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Free, no-key Census geography files:
 * - 2020 ZCTA <-> tract relationship file (23 MB national, one-time download):
 *   maps a ZIP (ZCTA) to the census tracts it overlaps, with land-area parts.
 * - 2020 Gazetteer tract files (per state, ~300 KB): each tract's internal
 *   point lat/lng — a Census-chosen representative point inside the tract.
 */

const REL_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tract20_natl.txt';
const GAZ_URL = (stateFips: string) =>
  `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_gaz_tracts_${stateFips}.txt`;

export interface ZipTract {
  tractGeoid: string;
  /** Share of the ZIP's land area this tract covers (0..1). */
  zipLandShare: number;
  /** Share of the tract's land area inside this ZIP (0..1). */
  tractLandShare: number;
}

export interface TractPoint {
  tractGeoid: string;
  name: string;
  lat: number;
  lng: number;
}

export interface TractFileResolver {
  tractsForZip(zip: string): Promise<ZipTract[]>;
  tractPoint(tractGeoid: string): Promise<TractPoint>;
}

async function readOrDownload(cachePath: string, url: string): Promise<string> {
  try {
    return await readFile(cachePath, 'utf8');
  } catch {
    console.log(`[zip] downloading ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
    const text = await res.text();
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, text);
    return text;
  }
}

/** Splits a delimited Census text file into header + records keyed by column. */
function parseTable(text: string, delimiter: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(delimiter).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(delimiter);
    return Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? '').trim()]));
  });
}

export class CensusTractFiles implements TractFileResolver {
  constructor(private readonly cacheDir = join('data', 'cache')) {}

  async tractsForZip(zip: string): Promise<ZipTract[]> {
    const cachePath = join(this.cacheDir, `zip-tracts-${zip}.json`);
    try {
      return JSON.parse(await readFile(cachePath, 'utf8')) as ZipTract[];
    } catch {
      // cache miss — resolve from the national file
    }
    const text = await readOrDownload(join(this.cacheDir, 'tab20_zcta520_tract20_natl.txt'), REL_URL);
    const rows = parseTable(text, '|');
    const matches = rows.filter((r) => r.GEOID_ZCTA5_20 === zip && r.GEOID_TRACT_20);
    if (matches.length === 0) {
      throw new Error(`ZIP ${zip} not found in the 2020 ZCTA-tract relationship file`);
    }
    const zipLand = matches.reduce((s, r) => s + Number(r.AREALAND_PART ?? 0), 0);
    const tracts: ZipTract[] = matches
      .map((r) => ({
        tractGeoid: r.GEOID_TRACT_20,
        zipLandShare: zipLand > 0 ? Number(r.AREALAND_PART ?? 0) / zipLand : 0,
        tractLandShare:
          Number(r.AREALAND_TRACT_20 ?? 0) > 0
            ? Number(r.AREALAND_PART ?? 0) / Number(r.AREALAND_TRACT_20)
            : 0,
      }))
      .sort((a, b) => b.zipLandShare - a.zipLandShare);
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(tracts, null, 2));
    return tracts;
  }

  async tractPoint(tractGeoid: string): Promise<TractPoint> {
    const stateFips = tractGeoid.slice(0, 2);
    const text = await readOrDownload(
      join(this.cacheDir, `2020_gaz_tracts_${stateFips}.txt`),
      GAZ_URL(stateFips),
    );
    const rows = parseTable(text, '\t');
    const row = rows.find((r) => r.GEOID === tractGeoid || r.GEOID?.replace(/^0+/, '') === tractGeoid.replace(/^0+/, ''));
    if (!row) throw new Error(`tract ${tractGeoid} not in gazetteer for state ${stateFips}`);
    return {
      tractGeoid,
      name: row.NAME ?? `Census Tract ${tractGeoid.slice(5)}`,
      lat: Number(row.INTPTLAT),
      lng: Number(row.INTPTLONG),
    };
  }
}
