import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Why an event can't be serialized:
 * - `'circular-reference'`: the event refers back to an object that contains the reference, so its payload would be
 *   infinite. `path` is the property that closes the cycle.
 * - `'class-transformer-decorators'`: thrown at bootstrap. The event carries class-transformer decorators (`@Type`,
 *   `@Transform`, `@Expose` or `@Exclude`), which the default `JsonEventSerializer` ignores, so it would store and read
 *   the event differently than 3.x did. `decorators` lists them.
 */
export type EventSerializationFailure = 'circular-reference' | 'class-transformer-decorators';

/**
 * Thrown when an event can't be serialized. An append that throws it has written nothing.
 */
export class EventSerializationException extends EventSourcingError {
	override readonly name = 'EventSerializationException';
	readonly code = EventSourcingErrorCode.EventSerialization;
	/** The class name of the event. */
	readonly event: string;
	readonly reason: EventSerializationFailure;
	/** `'circular-reference'`: the property path that refers back to an enclosing object, such as `owner.accounts[0]`. */
	readonly path?: string;
	/** `'class-transformer-decorators'`: the decorators found, such as `@Type on FundsDeposited.amount`. */
	readonly decorators?: string[];

	constructor(
		details: { event: string; reason: EventSerializationFailure; path?: string; decorators?: string[] },
		options?: ErrorOptions,
	) {
		super(messageOf(details), options);
		this.event = details?.event;
		this.reason = details?.reason;
		this.path = details?.path;
		this.decorators = details?.decorators;
	}
}

const messageOf = (details: ConstructorParameters<typeof EventSerializationException>[0]): string => {
	const event = details?.event ?? 'unknown';
	switch (details?.reason) {
		case 'circular-reference':
			return `Cannot serialize the event ${event}: ${details.path || 'a property'} refers back to an object that contains it (a circular reference). An event payload must be a tree.`;
		case 'class-transformer-decorators':
			return `The event ${event} uses class-transformer decorators (${details.decorators?.join(', ') || 'unknown'}), which the default JsonEventSerializer ignores. Serialize it with class-transformer: set defaultEventSerializer: ClassTransformerEventSerializer (from '@ocoda/event-sourcing/class-transformer') in EventSourcingModule.forRoot(), or register an @EventSerializer() for the event.`;
		default:
			return `Cannot serialize the event ${event}.`;
	}
};
