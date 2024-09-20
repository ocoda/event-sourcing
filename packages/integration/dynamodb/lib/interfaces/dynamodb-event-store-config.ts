import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { Type } from '@nestjs/common';
import { EventStoreConfig } from '@ocoda/event-sourcing';
import { DynamoDBEventStore } from '../dynamodb.event-store';

export interface DynamoDBEventStoreConfig extends EventStoreConfig, DynamoDBClientConfig {
	driver: Type<DynamoDBEventStore>;
}
