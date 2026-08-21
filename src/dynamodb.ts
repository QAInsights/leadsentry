import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { LeadScoreRecord } from './scoreLead.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT?.trim() || undefined;
  const client = new DynamoDBClient({
    endpoint,
    region: process.env.AWS_REGION?.trim() || 'us-east-1',
    credentials: endpoint ? { accessKeyId: 'local', secretAccessKey: 'local' } : undefined,
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

let client: DynamoDBDocumentClient | undefined;

export async function saveLeadScore(record: LeadScoreRecord): Promise<void> {
  client ??= createClient();
  await client.send(
    new PutCommand({
      TableName: requiredEnv('TABLE_NAME'),
      Item: record,
    }),
  );
}
