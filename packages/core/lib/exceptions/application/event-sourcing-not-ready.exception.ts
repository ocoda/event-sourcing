import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when events are appended or read (`appendEvents`, `getEvent`, `getEvents`), a command or query is executed,
 * events are published or the event map is used while Nest is still instantiating the providers, for instance from a
 * provider factory or a constructor. The handlers, subscribers, publishers and serializers are registered once every
 * provider exists, so it is thrown before anything was read, written, executed or published. Reading envelopes
 * (`getEnvelope`, `getEnvelopes`, `readAll`) needs no registration and works from there.
 *
 * Move the call to a lifecycle hook (`onModuleInit` or later): from there on, the module registers everything on first
 * use.
 */
export class EventSourcingNotReadyException extends EventSourcingError {
	override readonly name = 'EventSourcingNotReadyException';
	readonly code = EventSourcingErrorCode.EventSourcingNotReady;
	/** What was called, such as `'CommandBus.execute'`. */
	readonly operation?: string;
	/** The providers that Nest was still instantiating, by name. */
	readonly pendingProviders: readonly string[];

	constructor(details?: { operation?: string; pendingProviders?: readonly string[] }, options?: ErrorOptions) {
		const pendingProviders = Object.freeze([...(details?.pendingProviders ?? [])]);
		const pending = pendingProviders.length
			? ` (still instantiating ${pendingProviders.slice(0, 5).join(', ')}${pendingProviders.length > 5 ? ', ...' : ''})`
			: '';
		super(
			`${details?.operation ?? 'The event sourcing module'} was used while Nest was instantiating the providers${pending}. The handlers are registered once every provider exists: move the call to onModuleInit or a later lifecycle hook.`,
			options,
		);
		this.operation = details?.operation;
		this.pendingProviders = pendingProviders;
	}
}
