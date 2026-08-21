import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../handler.js';

function event(body: string | null, method = 'POST'): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${method} /score`,
    rawPath: '/score',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: { method, path: '/score', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: 'test',
      routeKey: `${method} /score`,
      stage: '$default',
      time: '20/Aug/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body ?? undefined,
    isBase64Encoded: false,
  };
}

describe('Lambda handler', () => {
  it('returns the score response for a valid request', async () => {
    const score = vi.fn().mockResolvedValue({ id: 'assessment-1', score: 72 });
    const result = await createHandler(score)(event('{"address":"436 Massachusetts Ave, Buffalo, NY 14213"}'));

    expect(result).toMatchObject({ statusCode: 200 });
    if (typeof result === 'string') throw new Error('Expected a structured Lambda response');
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(result.body as string)).toEqual({ id: 'assessment-1', score: 72 });
    expect(score).toHaveBeenCalledWith({ address: '436 Massachusetts Ave, Buffalo, NY 14213' });
  });

  it('returns 400 for malformed JSON', async () => {
    const score = vi.fn();
    const result = await createHandler(score)(event('{'));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(score).not.toHaveBeenCalled();
  });

  it('returns 400 for unsupported request fields', async () => {
    const score = vi.fn();
    const result = await createHandler(score)(event('{"address":"123 Main Street","yearBuilt":1965}'));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(score).not.toHaveBeenCalled();
  });

  it('returns 413 for an oversized request body', async () => {
    const score = vi.fn();
    const result = await createHandler(score)(event(JSON.stringify({ address: 'a'.repeat(17_000) })));

    expect(result).toMatchObject({ statusCode: 413 });
    expect(score).not.toHaveBeenCalled();
  });

  it('returns 405 for non-POST requests', async () => {
    const result = await createHandler(vi.fn())(event(null, 'GET'));

    expect(result).toMatchObject({ statusCode: 405 });
  });
});
