import { ModuleMetadata, Type } from '@nestjs/common';
import { IEvent } from './events';

type DatabaseType = 'in-memory' | 'mongodb' | 'elasticsearch';

interface BaseEventSourcingModuleOptions<T extends DatabaseType> {
	database: T;
	events: Type<IEvent>[];
	disableDefaultSerializer?: boolean;
}

interface MongoDBEventSourcingModuleOptions extends BaseEventSourcingModuleOptions<'mongodb'> {
	url: string;
}

interface ElasticsearchEventSourcingModuleOptions extends BaseEventSourcingModuleOptions<'elasticsearch'> {
	url: string;
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
