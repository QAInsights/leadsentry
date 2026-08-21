import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { leadScoreRequestSchema, scoreLead, type LeadScoreRequest } from './src/scoreLead.js';

const headers = {
  'Content-Type': 'application/json',
};

type ScoreLead = (request: LeadScoreRequest) => Promise<unknown>;

class RequestTooLargeError extends Error {}

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2): LeadScoreRequest {
  if (!event.body) throw new SyntaxError('Request body is required');
  const bytes = Buffer.byteLength(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes > 16_384) throw new RequestTooLargeError('Request body is too large');
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return leadScoreRequestSchema.parse(JSON.parse(body));
}

export function createHandler(score: ScoreLead = scoreLead) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    if (event.requestContext?.http?.method && event.requestContext.http.method !== 'POST') {
      return response(405, { error: 'Method not allowed' });
    }

    try {
      return response(200, await score(parseBody(event)));
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return response(413, { error: 'Request body is too large' });
      }
      if (error instanceof SyntaxError || error instanceof ZodError) {
        return response(400, { error: 'Request body must be JSON with one non-empty address field' });
      }
      console.error('[lambda] scoring failed', error);
      return response(500, { error: 'Scoring failed' });
    }
  };
}

export const handler = createHandler();
