/**
 * Client for the NYSDOH Childhood Blood Lead Testing and Elevated Incidence
 * by Zip Code dataset (Socrata / health.data.ny.gov).
 *
 * Endpoint: https://health.data.ny.gov/resource/d54z-enu8.json
 * Key columns:
 *   - zip
 *   - year
 *   - tests
 *   - total_eblls
 *   - rate_per_1_000  (EBLLs per 1,000 children tested that year)
 *   - percent         (EBLLs / tests, as a fraction)
 *
 * The dataset is public and requires no API key. Some years/ZIPs have no
 * reported elevated results and therefore omit the rate columns.
 */

const NYSDOH_ENDPOINT = 'https://health.data.ny.gov/resource/d54z-enu8.json';

export interface NysdohRecord {
  zip: string;
  year: number;
  tests: number;
  /** Total children with confirmed elevated BLL in this ZIP and year. */
  totalEblls: number | null;
  /** Elevated BLL rate per 1,000 children tested. */
  ratePer1000: number | null;
  /** EBLLs / tests as a fraction (0..1). */
  percent: number | null;
}

export interface NysdohFetchOptions {
  /** Limit to a specific year. If omitted, the latest year with a rate is used per ZIP. */
  year?: number;
  /** Socrata query timeout in ms. */
  timeout?: number;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildSelect(): string {
  return ['zip', 'year', 'tests', 'total_eblls', 'rate_per_1_000', 'percent'].join(',');
}

function buildWhere(zips: string[], year?: number): string {
  const quoted = zips.map((z) => `'${z.replace(/'/g, "''")}'`).join(',');
  const conditions = [`zip in(${quoted})`];
  if (year !== undefined) {
    conditions.push(`year=${year}`);
  }
  return conditions.join(' AND ');
}

/**
 * Fetch NYSDOH blood-lead incidence for the given ZIPs.
 * If `year` is not specified, returns the most recent year per ZIP that has a
 * non-null `rate_per_1_000`. Falls back to the latest year with any data if no
 * rate is available.
 */
export async function fetchNysdohRates(
  zips: string[],
  options: NysdohFetchOptions = {},
): Promise<Map<string, NysdohRecord>> {
  if (zips.length === 0) return new Map();

  const url = new URL(NYSDOH_ENDPOINT);
  url.searchParams.set('$select', buildSelect());
  url.searchParams.set('$where', buildWhere(zips, options.year));
  url.searchParams.set('$limit', String(Math.max(zips.length * 100, 1000)));

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(options.timeout ?? 30_000),
  });
  if (!res.ok) {
    throw new Error(`NYSDOH request failed (${res.status}): ${await res.text().catch(() => 'unknown')}`);
  }

  const rows = (await res.json()) as Array<Record<string, unknown>>;

  // Group by zip and pick the best record.
  const byZip = new Map<string, NysdohRecord[]>();
  for (const row of rows) {
    const zip = String(row.zip ?? '');
    if (!zip) continue;
    const tests = toNumber(row.tests);
    if (tests === null || tests <= 0) continue;

    const record: NysdohRecord = {
      zip,
      year: toNumber(row.year) ?? 0,
      tests,
      totalEblls: toNumber(row.total_eblls),
      ratePer1000: toNumber(row.rate_per_1_000),
      percent: toNumber(row.percent),
    };
    const list = byZip.get(zip) ?? [];
    list.push(record);
    byZip.set(zip, list);
  }

  const result = new Map<string, NysdohRecord>();
  for (const zip of zips) {
    const list = byZip.get(zip);
    if (!list || list.length === 0) continue;

    // Prefer the latest year with a non-null rate.
    const withRate = list
      .filter((r) => r.ratePer1000 !== null)
      .sort((a, b) => b.year - a.year);
    if (withRate.length > 0) {
      result.set(zip, withRate[0]);
      continue;
    }

    // Otherwise, the latest year with any data.
    const latest = list.sort((a, b) => b.year - a.year)[0];
    result.set(zip, latest);
  }

  return result;
}
