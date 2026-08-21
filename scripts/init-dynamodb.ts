import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';

const tableName = process.env.TABLE_NAME?.trim() || 'LeadSentryLocal';
const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT?.trim() || 'http://127.0.0.1:8000',
  region: process.env.AWS_REGION?.trim() || 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

const createTable = async (): Promise<boolean> => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceInUseException') return false;
      if (attempt === 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
};

try {
  const created = await createTable();
  if (created) {
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
    console.log(`Created DynamoDB Local table ${tableName}`);
  } else {
    console.log(`DynamoDB Local table ${tableName} already exists`);
  }
} finally {
  client.destroy();
}
