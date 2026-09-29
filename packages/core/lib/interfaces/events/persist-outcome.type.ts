import type { EventStream } from '../../models/index.js';
import type { IEventCollection } from './event-collection.type.js';
import type { IEventPool } from './event-pool.type.js';

/**
 * The result of an event store's `persistEvents`.
 * - `committed`: every envelope was stored; `positions` holds the global position of each envelope, in order.
 * - `conflict`: nothing was stored, because another append already took one of the versions. `actualVersion` is the
 *   version of the stream if the store knows it, and `cause` the underlying error, such as the duplicate-key error.
 *
 * Every other failure is thrown, preferably as an `EventStorePersistenceException` with the outcome the store knows.
 */
export type PersistOutcome =
	| { status: 'committed'; positions: readonly bigint[] }
	| { status: 'conflict'; actualVersion?: number; cause?: unknown };

/**
 * Where `persistEvents` writes the envelopes of an append.
 */
export interface PersistTarget {
	/**
	 * The stream the envelopes belong to.
	 */
	stream: EventStream;
	/**
	 * The collection (table) of the pool.
	 */
	collection: IEventCollection;
	/**
	 * The version of the stream before the append, as `getStreamVersion` read it. The first envelope has version
	 * `expectedVersion + 1`.
	 */
	expectedVersion: number;
	/**
	 * The event pool, `undefined` for the default pool.
	 */
	pool?: IEventPool;
}
