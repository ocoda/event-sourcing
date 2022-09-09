import { ClientOptions } from '@elastic/elasticsearch';
import { ModuleMetadata, Type } from '@nestjs/common';
import { MongoClientOptions } from 'mongodb';
import { IEvent } from './events';

type DatabaseType = 'in-memory' | 'mongodb' | 'elasticsearch';

interface BaseEventSourcingModuleOptions<T extends DatabaseType> {
	events: Type<IEvent>[];
	database?: T;
	disableDefaultSerializer?: boolean;
}

interface MongoDBEventSourcingModuleOptions extends BaseEventSourcingModuleOptions<'mongodb'> {
	connection: {
		url: string;
		options?: MongoClientOptions;
	};
}

interface ElasticsearchEventSourcingModuleOptions extends BaseEventSourcingModuleOptions<'elasticsearch'> {
	connection: ClientOptions;
}

export type EventSourcingModuleOptions =
	| BaseEventSourcingModuleOptions<'in-memory'>
	| MongoDBEventSourcingModuleOptions
	| ElasticsearchEventSourcingModuleOptions;

export interface EventSourcingOptionsFactory {
	createEventSourcingOptions: () => Promise<EventSourcingModuleOptions> | EventSourcingModuleOptions;
}

export interface EventSourcingModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
	useExisting?: Type<EventSourcingOptionsFactory>;
	useClass?: Type<EventSourcingOptionsFactory>;
	useFactory?: (...args: any[]) => Promise<EventSourcingModuleOptions> | EventSourcingModuleOptions;
	inject?: any[];
}
