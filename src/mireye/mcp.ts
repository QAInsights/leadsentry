import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type {
  FetchedField,
  MireyeClient,
  MireyeFetchResult,
} from './types.js';
import { LEADSENTRY_FIELDS } from './types.js';

const MCP_URL = 'https://api.mireye.com/mcp';

/**
 * Client over Mireye's MCP server. Preferred path: it exercises the
 * exact surface the hackathon is built around (mireye_fetch, mireye_ask,
 * mireye_request_field...). Two transports:
 *   - stdio: the local `mireye-mcp` adapter (uvx), authed via
 *     MIREYE_BEARER_TOKEN or a prior `mireye-mcp login`
 *   - http: the hosted endpoint (OAuth-only in practice; raw bearer gets 401)
 * Falls back to REST if neither works.
 */
export class MireyeMcpClient implements MireyeClient {
  readonly mode = 'mcp' as const;
  private client: MCPClient | null = null;

  private constructor(private readonly token: string) {}

  /** Local stdio adapter: `uvx mireye-mcp` with the bearer token in env. */
  static async connectStdio(token: string): Promise<MireyeMcpClient> {
    const instance = new MireyeMcpClient(token);
    instance.client = await createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: 'uvx',
        args: ['mireye-mcp'],
        env: { ...process.env, MIREYE_BEARER_TOKEN: token } as Record<string, string>,
      }),
    });
    await instance.smokeTest();
    return instance;
  }

  /** Hosted endpoint — OAuth-only as of catalog 0.6.0; kept as second try. */
  static async connect(token: string): Promise<MireyeMcpClient> {
    const instance = new MireyeMcpClient(token);
    instance.client = await createMCPClient({
      transport: {
        type: 'http',
        url: MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    await instance.smokeTest();
    return instance;
  }

  /** A one-field coordinate fetch proves auth and connectivity. */
  private async smokeTest(): Promise<void> {
    await this.callTool('mireye_fetch', {
      lat: 40.7128,
      lng: -74.006,
      fields: ['elevation'],
    });
  }

  private ensureClient(): MCPClient {
    if (!this.client) throw new Error('MCP client not connected');
    return this.client;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.ensureClient().callTool({ name, arguments: args });
    if (result.isError) {
      const parts = Array.isArray(result.content) ? result.content : [];
      const text = parts.find((c: { type: string }) => c.type === 'text');
      throw new Error(`MCP tool ${name} returned an error: ${text && 'text' in text ? String(text.text) : 'unknown'}`);
    }
    return result;
  }

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
    const raw = await this.callTool('mireye_fetch', location);
    // MCP tool results carry the verbatim /v1/fetch JSON body.
    const data = normalizeMcpResult(raw) as {
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
    // mireye_request_field schema (from the server's listTools): description +
    // example_locations are the core inputs; use_case/requested_fields sharpen it.
    return normalizeMcpResult(
      await this.callTool('mireye_request_field', {
        description: question,
        example_locations: [{ lat, lng }],
        use_case:
          'Childhood lead-exposure triage: pre-1980 housing share drives CDC/HUD lead-risk ' +
          'models, but Census ACS data is tract-level. A parcel-level year-built field would ' +
          'let health departments prioritize addresses within high-risk tracts.',
        requested_fields: ['year_built'],
        idempotency_key: `leadsentry-year-built-${lat.toFixed(5)}-${lng.toFixed(5)}`,
      }),
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

/** MCP tool results may be JSON text content or structured content. */
function normalizeMcpResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    const r = raw as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    if (r.structuredContent) return r.structuredContent;
    const textPart = r.content?.find((c) => c.type === 'text' && c.text);
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return { raw_text: textPart.text };
      }
    }
  }
  return raw;
}
