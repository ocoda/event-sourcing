import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { Type } from '@nestjs/common';
import type { EventStoreConfig } from '@ocoda/event-sourcing';
import type { DynamoDBEventStore } from '../dynamodb.event-store';

export interface DynamoDBEventStoreConfig extends EventStoreConfig, DynamoDBClientConfig {
	driver: Type<DynamoDBEventStore>;
}
