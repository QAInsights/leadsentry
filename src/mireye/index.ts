import type { MireyeClient } from './types.js';
import { MireyeMcpClient } from './mcp.js';
import { MireyeRestClient } from './rest.js';
import { DemoMireyeClient } from '../demo/fixtures.js';
import { RateLimitedMireyeClient } from './rateLimit.js';

export type { MireyeClient } from './types.js';
export { LEADSENTRY_FIELDS } from './types.js';

/**
 * Connect to Mireye. Order of preference:
 *   1. demo fixtures (no token / --demo flag)
 *   2. MCP via local stdio adapter (uvx mireye-mcp + MIREYE_BEARER_TOKEN)
 *   3. hosted MCP endpoint (OAuth-only in practice; bearer gets 401)
 *   4. direct REST /v1/fetch
 */
export async function connectMireye(
  token: string | null,
  demo: boolean,
): Promise<MireyeClient> {
  if (demo || !token) {
    if (!demo && !token) {
      console.log('[mireye] no MIREYE_API_TOKEN — falling back to demo fixtures');
    }
    return new DemoMireyeClient();
  }
  try {
    const client = await MireyeMcpClient.connectStdio(token);
    console.log('[mireye] connected via MCP (stdio adapter, uvx mireye-mcp)');
    return new RateLimitedMireyeClient(client);
  } catch (err) {
    console.log(
      `[mireye] stdio MCP unavailable (${(err as Error).message.slice(0, 160)}) — trying hosted MCP`,
    );
  }
  try {
    const client = await MireyeMcpClient.connect(token);
    console.log('[mireye] connected via hosted MCP server');
    return new RateLimitedMireyeClient(client);
  } catch (err) {
    console.log(
      `[mireye] hosted MCP unavailable (${(err as Error).message.slice(0, 160)}) — using REST /v1/fetch`,
    );
    return new RateLimitedMireyeClient(new MireyeRestClient(token));
  }
}
