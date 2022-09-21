import { ClientOptions } from '@elastic/elasticsearch';
import { ModuleMetadata, Type } from '@nestjs/common';
import { MongoClientOptions } from 'mongodb';
import { IEvent } from './events';

type InMemoryStoreConfig = { client: 'in-memory' };
type MongoDbStoreConfig = { client: 'mongodb'; options: { url: string } & MongoClientOptions };
type ElasticsearchStoreConfig = { client: 'elasticsearch'; options: ClientOptions };

export interface EventSourcingModuleOptions {
	events: Type<IEvent>[];
	eventStore?: InMemoryStoreConfig | MongoDbStoreConfig | ElasticsearchStoreConfig;
	snapshotStore?: InMemoryStoreConfig | MongoDbStoreConfig | ElasticsearchStoreConfig;
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
