import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { ModuleMetadata, Type } from '@nestjs/common';
import { MongoClientOptions } from 'mongodb';
import { IEvent } from './events';

type InMemoryStoreConfig = { client: 'in-memory' };
type MongoDbStoreConfig = { client: 'mongodb'; options: { url: string } & MongoClientOptions };
type DynamoDbStoreConfig = { client: 'dynamodb'; options: DynamoDBClientConfig };

export interface EventSourcingModuleOptions {
	events: Type<IEvent>[];
	eventStore?: InMemoryStoreConfig | MongoDbStoreConfig | DynamoDbStoreConfig;
	snapshotStore?: InMemoryStoreConfig | MongoDbStoreConfig;
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
