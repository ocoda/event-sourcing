import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { ModuleMetadata, Type } from '@nestjs/common';
import type { MongoClientOptions } from 'mongodb';
import { IEvent } from './events';

type InMemoryStoreConfig = { client: 'in-memory' };
type MongoDBStoreConfig = { client: 'mongodb'; options: { url: string } & MongoClientOptions };
type DynamoDBStoreConfig = { client: 'dynamodb'; options: DynamoDBClientConfig };

export interface EventSourcingModuleOptions {
	events: Type<IEvent>[];
	eventStore?: InMemoryStoreConfig | MongoDBStoreConfig | DynamoDBStoreConfig;
	snapshotStore?: InMemoryStoreConfig | MongoDBStoreConfig | DynamoDBStoreConfig;
	disableDefaultSerializer?: boolean;
}

export interface EventSourcingOptionsFactory {
	createEventSourcingOptions: () => Promise<EventSourcingModuleOptions> | EventSourcingModuleOptions;
}

export interface EventSourcingModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
	useExisting?: Type<EventSourcingOptionsFactory>;
	useClass?: Type<EventSourcingOptionsFactory>;
	useFactory?: (...args: any[]) => Promise<EventSourcingModuleOptions> | EventSourcingModuleOptions;
	inject?: any[];
}
