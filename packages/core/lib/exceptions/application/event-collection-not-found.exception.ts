import type { IEventCollection, IEventPool } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when an event store reads from a pool whose collection doesn't exist (or isn't registered in the store's
 * catalog). Create it with `ensureCollection(pool)`. An append to such a pool fails with an
 * `EventStorePersistenceException` whose `cause` is this exception.
 */
export class EventCollectionNotFoundException extends EventSourcingError {
	override readonly name = 'EventCollectionNotFoundException';
	readonly code = EventSourcingErrorCode.EventCollectionNotFound;
	readonly collection: IEventCollection;
	readonly pool?: IEventPool;

	constructor(details: { collection: IEventCollection; pool?: IEventPool }, options?: ErrorOptions) {
		super(
			`The ${details?.collection ?? 'unknown'} collection${details?.pool ? ` of the ${details.pool} pool` : ''} does not exist. Create it with ensureCollection().`,
			options,
		);
		this.collection = details?.collection;
		this.pool = details?.pool;
	}
}
