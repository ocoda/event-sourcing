import { IEventPool } from './event-pool.type';

export interface EventStoreDriver {
	connect(): void | Promise<void>;
	disconnect(): void | Promise<void>;
	ensureCollection(pool?: IEventPool): unknown | Promise<unknown>;
}
