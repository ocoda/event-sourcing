import type { IEventCollection } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when an event store fails to append events for another reason than a version conflict. The underlying error
 * is the `cause`.
 */
export class EventStorePersistenceException extends EventSourcingError {
	override readonly name = 'EventStorePersistenceException';
	readonly code = EventSourcingErrorCode.EventStorePersistence;
	readonly collection: IEventCollection;
	/**
	 * Whether the events of the failed append were stored. `'unknown'` unless the store knows nothing was written.
	 * - `'not-persisted'`: the append failed before anything was written, so nothing was stored.
	 * - `'unknown'`: the append failed while or after writing, for instance when the connection dropped around the
	 *   commit. Retrying with the same numeric expected version is safe: if the first attempt was stored, the retry
	 *   conflicts.
	 */
	readonly outcome: 'not-persisted' | 'unknown';

	constructor(details: { collection: IEventCollection; outcome: 'not-persisted' | 'unknown' }, options?: ErrorOptions) {
		const outcome = details?.outcome ?? 'unknown';
		super(
			`An error occurred while appending events to the ${details?.collection} collection${outcome === 'unknown' ? '; they may have been stored' : ''}.`,
			options,
		);
		this.collection = details?.collection;
		this.outcome = outcome;
	}
}
