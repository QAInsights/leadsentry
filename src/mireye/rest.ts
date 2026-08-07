import type {
  FetchedField,
  MireyeClient,
  MireyeFetchResult,
} from './types.js';
import { LEADSENTRY_FIELDS } from './types.js';

const BASE_URL = 'https://api.mireye.com';

/**
 * Direct REST client for /v1/fetch — the fallback when the hosted MCP
 * endpoint refuses bearer-token auth, and the deterministic fast path.
 * Failed fields are auto-refunded server-side per the docs.
 */
export class MireyeRestClient implements MireyeClient {
  readonly mode = 'rest' as const;

  constructor(private readonly token: string) {}

  async fetchForAddress(
    address: string,
    fields: readonly string[] = LEADSENTRY_FIELDS,
  ): Promise<MireyeFetchResult> {
    return this.fetch({ address, fields: [...fields] }, address);
  }

  async fetchForPoint(
    lat: number,
    lng: number,
    fields: readonly string[] = LEADSENTRY_FIELDS,
  ): Promise<MireyeFetchResult> {
    return this.fetch({ lat, lng, fields: [...fields] }, `${lat},${lng}`);
  }

  private async fetch(
    location: Record<string, unknown>,
    label: string,
  ): Promise<MireyeFetchResult> {
    const res = await fetch(`${BASE_URL}/v1/fetch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(location),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Mireye /v1/fetch failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      lat?: number;
      lng?: number;
      fields?: Record<string, FetchedField>;
      partial_failures?: unknown[];
      geocode?: { parcel_grade?: boolean; normalized_address?: string };
    };
    return {
      address: label,
      lat: data.lat ?? null,
      lng: data.lng ?? null,
      parcelGrade: data.geocode?.parcel_grade ?? null,
      normalizedAddress: data.geocode?.normalized_address ?? null,
      fields: data.fields ?? {},
      partialFailures: data.partial_failures ?? [],
    };
  }

  async requestField(question: string, lat: number, lng: number): Promise<unknown> {
    const res = await fetch(`${BASE_URL}/v1/field-requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        description: question,
        example_locations: [{ lat, lng }],
        use_case:
          'Childhood lead-exposure triage: pre-1980 housing share drives CDC/HUD lead-risk ' +
          'models, but Census ACS data is tract-level. A parcel-level year-built field would ' +
          'let health departments prioritize addresses within high-risk tracts.',
        requested_fields: ['year_built'],
        idempotency_key: `leadsentry-year-built-${lat.toFixed(5)}-${lng.toFixed(5)}`,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { error: `field request failed (${res.status})` };
    return res.json();
  }

  async close(): Promise<void> {}
}
