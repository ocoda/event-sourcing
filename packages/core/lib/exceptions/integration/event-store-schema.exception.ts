import type { IEventCollection } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * What an event store found instead of a collection with its current schema:
 * - `'missing'`: no collection (with `ddl: 'none'`, the store doesn't create it).
 * - `'v1'`: a collection with the 3.x schema, which has to be migrated.
 * - `'v1-partial'`: a 3.x collection whose migration didn't finish.
 * - `'unregistered'`: a collection that is missing from the store's catalog.
 */
export type EventStoreSchemaFinding = 'missing' | 'v1' | 'v1-partial' | 'unregistered';

/**
 * Thrown when an event store can't use a collection as it is, typically a 3.x collection that wasn't migrated.
 * The `remedy` says what to do, such as running the store's `migrate()`.
 */
export class EventStoreSchemaException extends EventSourcingError {
	override readonly name = 'EventStoreSchemaException';
	readonly code = EventSourcingErrorCode.EventStoreSchema;
	readonly collection: IEventCollection;
	readonly found: EventStoreSchemaFinding;
	/** What to do about it. */
	readonly remedy: string;

	constructor(
		details: { collection: IEventCollection; found: EventStoreSchemaFinding; remedy: string },
		options?: ErrorOptions,
	) {
		super(
			`The ${details?.collection ?? 'unknown'} collection ${describeFinding(details?.found)}.${details?.remedy ? ` ${details.remedy}` : ''}`,
			options,
		);
		this.collection = details?.collection;
		this.found = details?.found;
		this.remedy = details?.remedy;
	}
}

const describeFinding = (found: EventStoreSchemaFinding | undefined): string => {
	switch (found) {
		case 'missing':
			return 'does not exist';
		case 'v1':
			return 'has the 3.x schema';
		case 'v1-partial':
			return 'has a partly migrated 3.x schema';
		case 'unregistered':
			return 'is not registered in the catalog of the store';
		default:
			return 'does not have the expected schema';
	}
};
