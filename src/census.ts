import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Census ACS 5-year, Table B25034 (Year Structure Built), tract level.
 * Pre-1980 share = (B25034_007E + _008E + _009E + _010E + _011E) / B25034_001E
 * Bins: 007=1970-79, 008=1960-69, 009=1950-59, 010=1940-49, 011=1939 or earlier.
 * Verified live against api.census.gov (2023 ACS 5-year). A free API key is
 * required (keyless requests 302 to missing_key.html as of 2025).
 */

const ACS_YEAR = '2023';
const PRE1980_VARS = [
  'B25034_007E',
  'B25034_008E',
  'B25034_009E',
  'B25034_010E',
  'B25034_011E',
];

export interface TractHousingAge {
  tractGeoid: string;
  totalUnits: number;
  pre1980Units: number;
  pre1980Share: number; // 0..1
  sourceUrl: string;
  fetchedAt: string;
  /** True when values came from demo fixtures, not the Census API. */
  illustrative: boolean;
}

export interface CensusClient {
  pre1980Share(tractGeoid: string): Promise<TractHousingAge>;
}

export class CensusAcsClient implements CensusClient {
  private readonly cacheDir: string;
  private readonly memory = new Map<string, TractHousingAge>();

  constructor(
    private readonly apiKey: string,
    cacheDir = join('data', 'cache'),
  ) {
    this.cacheDir = cacheDir;
  }

  async pre1980Share(tractGeoid: string): Promise<TractHousingAge> {
    if (!/^\d{11}$/.test(tractGeoid)) {
      throw new Error(`tract_geoid must be 11 digits, got "${tractGeoid}"`);
    }
    const hit = this.memory.get(tractGeoid) ?? (await this.readCache(tractGeoid));
    if (hit) return hit;

    const state = tractGeoid.slice(0, 2);
    const county = tractGeoid.slice(2, 5);
    const tract = tractGeoid.slice(5);
    const vars = ['NAME', 'B25034_001E', ...PRE1980_VARS].join(',');
    const url =
      `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${vars}` +
      `&for=tract:${tract}&in=state:${state}%20county:${county}&key=${this.apiKey}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`Census ACS failed (${res.status}) for tract ${tractGeoid}`);
    }
    // Census answers invalid/inactive keys with a 302 to an HTML page, which
    // fetch follows — so a non-JSON body means key trouble, not missing data.
    const body = await res.text();
    if (!body.startsWith('[')) {
      throw new Error(
        `Census ACS returned non-JSON for tract ${tractGeoid} — CENSUS_API_KEY is invalid or not activated (check the activation email from api.census.gov)`,
      );
    }
    const rows = JSON.parse(body) as string[][];
    if (!Array.isArray(rows) || rows.length < 2) {
      throw new Error(`Census ACS returned no data for tract ${tractGeoid}`);
    }
    const header = rows[0];
    const row = rows[1];
    const num = (name: string): number => {
      const idx = header.indexOf(name);
      if (idx === -1) {
        throw new Error(
          `Census ACS response for tract ${tractGeoid} is missing expected column "${name}" — got headers [${header.join(', ')}]. Possible API schema change.`,
        );
      }
      const raw = row[idx];
      // Census returns empty strings for some special-case tracts; treat those as 0.
      const parsed = Number(raw ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const total = num('B25034_001E');
    const pre = PRE1980_VARS.reduce((sum, v) => sum + num(v), 0);
    const result: TractHousingAge = {
      tractGeoid,
      totalUnits: total,
      pre1980Units: pre,
      pre1980Share: total > 0 ? pre / total : 0,
      sourceUrl: url.replace(/&key=.*$/, '&key=REDACTED'),
      fetchedAt: new Date().toISOString(),
      illustrative: false,
    };
    this.memory.set(tractGeoid, result);
    await this.writeCache(result);
    return result;
  }

  private cachePath(geoid: string): string {
    return join(this.cacheDir, `tract-${geoid}.json`);
  }

  private async readCache(geoid: string): Promise<TractHousingAge | null> {
    try {
      const raw = await readFile(this.cachePath(geoid), 'utf8');
      const parsed = JSON.parse(raw) as TractHousingAge;
      this.memory.set(geoid, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCache(result: TractHousingAge): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.cachePath(result.tractGeoid), JSON.stringify(result, null, 2));
    } catch {
      // cache is best-effort
    }
  }
}
