import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { Type } from '@nestjs/common';
import type { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { DynamoDBSnapshotStore } from '../dynamodb.snapshot-store.js';

export interface DynamoDBSnapshotStoreConfig extends SnapshotStoreConfig, DynamoDBClientConfig {
	driver: Type<DynamoDBSnapshotStore>;
}
