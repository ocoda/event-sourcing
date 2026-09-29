import type { IEventPool } from './event-pool.type.js';

export interface EventStoreDriver {
	connect(): void | Promise<void>;
	disconnect(): void | Promise<void>;
	ensureCollection(pool?: IEventPool): unknown | Promise<unknown>;
}
