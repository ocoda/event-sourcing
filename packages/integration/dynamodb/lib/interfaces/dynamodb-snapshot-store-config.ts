import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { Type } from '@nestjs/common';
import { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import { DynamoDBSnapshotStore } from '../dynamodb-snapshot-store';

export interface DynamoDBSnapshotStoreConfig extends SnapshotStoreConfig, DynamoDBClientConfig {
	driver: Type<DynamoDBSnapshotStore>;
}
