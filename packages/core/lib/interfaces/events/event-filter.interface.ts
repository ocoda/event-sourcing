import type { StreamReadingDirection } from '../../constants.js';
import type { IEventPool } from './event-pool.type.js';

export interface IEventFilter {
	/**
	 * The version from where the events should be read.
	 */
	fromVersion?: number;
	/**
	 * The event pool to search in.
	 * @default events
	 */
	pool?: IEventPool;
	/**
	 * The direction in which events should be read.
	 * @default StreamReadingDirection.FORWARD
	 */
	direction?: StreamReadingDirection;
	/**
	 * The number of events to read
	 * @default Number.MAX_SAFE_INTEGER
	 */
	limit?: number;
	/**
	 * The amount of events to read at a time
	 * @default 100
	 */
	batch?: number;
}

/**
 * What `readAll` reads: the events of a pool, across streams, in the order of their global position.
 */
export interface IReadAllFilter {
	/**
	 * The global position to start at, inclusive (like `fromVersion`). `0n` or absent starts at the first event.
	 */
	fromPosition?: bigint;
	/**
	 * The amount of events to read at a time
	 * @default 100
	 */
	batch?: number;
	/**
	 * The event pool to read.
	 * @default events
	 */
	pool?: IEventPool;
}

export interface IEventCollectionFilter {
	/**
	 * The amount of collections to read at a time
	 * @default 100
	 */
	batch?: number;
}
