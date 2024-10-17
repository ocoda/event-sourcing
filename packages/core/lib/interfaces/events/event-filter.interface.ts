import type { StreamReadingDirection } from '../../constants';
import type { IEventPool } from './event-pool.type';

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

export interface IAllEventsFilter extends Pick<IEventFilter, 'pool' | 'batch'> {
	/**
	 * The year and month from where the events should be read.
	 */
	since: { year: number; month: number };

	/**
	 * The year and month up until where the events should be read.
	 * @default now
	 */
	until?: { year: number; month: number };
}

export interface IEventCollectionFilter {
	/**
	 * The amount of collections to read at a time
	 * @default 100
	 */
	batch?: number;
}
