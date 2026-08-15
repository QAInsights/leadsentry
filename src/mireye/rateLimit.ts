import type { MireyeClient, MireyeFetchResult } from './types.js';

// Mireye's free plan caps at 20 requests/minute. Stay a little under it so we
// don't ping-pong on the boundary when several tract/address fetches land in
// the same instant (ZIP mode runs up to `concurrency` fetches in parallel).
const MAX_REQUESTS_PER_MINUTE = 18;
const WINDOW_MS = 60_000;
const MAX_RETRIES = 3;

function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry_after_s["']?\s*[:=]\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function isRateLimited(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('429') || message.includes('rate_limited') || /rate limit/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a MireyeClient with a proactive rate limiter (stays under the
 * free-tier ~20 req/min cap) plus reactive retry-with-backoff on 429s,
 * honoring the server's `retry_after_s` when present.
 *
 * Without this, ZIP mode (concurrent tract fetches) and multi-ZIP validation
 * studies fire enough requests to blow through the free plan's limit and
 * crash the whole run with an unrecoverable fatal error.
 */
export class RateLimitedMireyeClient implements MireyeClient {
  readonly mode: MireyeClient['mode'];
  private readonly timestamps: number[] = [];

  constructor(private readonly inner: MireyeClient) {
    this.mode = inner.mode;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    while (this.timestamps.length > 0 && now - this.timestamps[0] >= WINDOW_MS) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      const waitMs = WINDOW_MS - (now - this.timestamps[0]) + 50;
      await sleep(Math.max(waitMs, 0));
      return this.throttle();
    }
    this.timestamps.push(now);
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      try {
        return await call();
      } catch (err) {
        if (attempt >= MAX_RETRIES || !isRateLimited(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const retryAfterS = parseRetryAfterSeconds(message) ?? 5 * (attempt + 1);
        console.log(
          `[mireye] rate limited — retrying in ${retryAfterS}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(retryAfterS * 1000 + 250);
      }
    }
  }

  fetchForAddress(address: string, fields?: readonly string[]): Promise<MireyeFetchResult> {
    return this.withRetry(() => this.inner.fetchForAddress(address, fields));
  }

  fetchForPoint(lat: number, lng: number, fields?: readonly string[]): Promise<MireyeFetchResult> {
    return this.withRetry(() => this.inner.fetchForPoint(lat, lng, fields));
  }

  requestField(question: string, lat: number, lng: number): Promise<unknown> {
    return this.withRetry(() => this.inner.requestField(question, lat, lng));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
