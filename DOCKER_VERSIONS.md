# Docker Database Versions

This document explains the pinned Docker database versions used in `docker-compose.yml`.

## Pinned Versions

All database versions have been pinned to specific versions to ensure stable and reproducible test environments.

### MongoDB: `mongo:8.2`
- **Status**: ✅ Tests passing
- **Version**: 8.2.2
- **Previously**: `mongo:8`
- **Reason**: Pinned to minor version (8.2) to avoid breaking changes in future 8.x releases while staying on the latest stable minor version.

### PostgreSQL: `postgres:17`
- **Status**: ✅ Tests passing
- **Version**: PostgreSQL 17.x
- **Previously**: `postgres:latest`
- **Reason**: The `latest` tag changed to PostgreSQL 18+ which introduced breaking changes in data storage format requiring migration with `pg_upgrade`. PostgreSQL 17 is stable and compatible with the current codebase.
- **Issue**: PostgreSQL 18+ requires major version-specific directory names and breaks when using tmpfs volumes without migration.

### MariaDB: `mariadb:12.1`
- **Status**: ✅ Tests passing
- **Version**: 12.1.2
- **Previously**: `mariadb:latest`
- **Reason**: Pinned to minor version (12.1) to ensure stability and avoid potential breaking changes in newer releases.

### DynamoDB Local: `amazon/dynamodb-local:1.22.0`
- **Status**: ❌ Tests failing (known issue)
- **Version**: 1.22.0
- **Previously**: `amazon/dynamodb-local:latest`
- **Issue**: Tests fail with timeout errors across all tested versions (1.22.0, 1.24.0, 2.0.0, 2.5.2, 2.5.3, 3.x).
- **Root Cause**: AWS SDK for JavaScript v3 (v3.883.0) requires explicit timeout configuration using `NodeHttpHandler`, which is not currently configured in the DynamoDB integration code. The default 120-second timeout and retry behavior causes test failures.
- **Versions Tested**: 
  - `latest` (v3.x) - File permission errors
  - `2.5.3` - Timeout errors
  - `2.5.2` - Timeout errors
  - `2.0.0` - Timeout errors
  - `1.24.0` - Timeout errors
  - `1.22.0` - Timeout errors (current)

## Reproduction

To test the integrations:

```bash
# Start all databases
docker compose up -d

# Test MongoDB
pnpm test --filter=@ocoda/event-sourcing-mongodb

# Test PostgreSQL
pnpm test --filter=@ocoda/event-sourcing-postgres

# Test MariaDB
pnpm test --filter=@ocoda/event-sourcing-mariadb

# Test all working integrations
pnpm test --filter='@ocoda/event-sourcing-mongodb' --filter='@ocoda/event-sourcing-postgres' --filter='@ocoda/event-sourcing-mariadb'
```

## DynamoDB Fix Required

To fix the DynamoDB tests, the DynamoDB integration code needs to be updated to configure timeouts explicitly:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';

const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:8000',
  credentials: { 
    accessKeyId: 'test-access-key',  // Dummy credentials for local development
    secretAccessKey: 'test-secret-key' 
  },
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 10000, // 10 seconds
    socketTimeout: 10000,     // 10 seconds
  }),
  maxAttempts: 2, // Reduce retries
});
```

This requires changes to `packages/integration/dynamodb/lib/dynamodb.event-store.ts` and `packages/integration/dynamodb/lib/dynamodb.snapshot-store.ts`.

## Version Update Policy

When updating database versions:

1. Test the new version locally first
2. Run all integration tests
3. Update this documentation with any issues found
4. Consider using minor version pins (e.g., `12.1` instead of `12`) for stability while allowing patch updates
