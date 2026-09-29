import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown at bootstrap when an event store overrides a method that the `EventStore` base class implements for every
 * store (`appendEvents`, `getEvent`, `getEvents`). Those methods validate appends, check versions and publish; a store
 * implements the driver methods (`getStreamVersion`, `persistEvents`, ...) instead. To decorate appends, for tracing
 * for instance, override `persistEvents` and call `super`.
 */
export class InvalidEventStoreImplementationException extends EventSourcingError {
	override readonly name = 'InvalidEventStoreImplementationException';
	readonly code = EventSourcingErrorCode.InvalidEventStoreImplementation;
	/** The class name of the store. */
	readonly store: string;
	/** The overridden methods. */
	readonly methods: string[];

	constructor(details: { store: string; methods: string[] }, options?: ErrorOptions) {
		const methods = details?.methods ?? [];
		super(
			`The event store ${details?.store ?? 'unknown'} overrides ${methods.length ? methods.join(', ') : 'a template method'} of EventStore. Implement the driver methods instead, and override persistEvents to decorate appends.`,
			options,
		);
		this.store = details?.store;
		this.methods = methods;
	}
}
