import { EVENT_SOURCING_ERROR, brandEventSourcingError } from './internal.js';

/**
 * The stable, machine-readable code of every error the library throws, one per exception class.
 *
 * Match on these (`isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)`) rather than on
 * messages, which may change in any release. The table is pinned by a snapshot test: renaming or removing a code is a
 * breaking change, adding one is not.
 */
export const EventSourcingErrorCode = {
	// Application
	CommandHandlerNotFound: 'ES_COMMAND_HANDLER_NOT_FOUND',
	EventNotFound: 'ES_EVENT_NOT_FOUND',
	InvalidAggregateStreamName: 'ES_INVALID_AGGREGATE_STREAM_NAME',
	InvalidCommandHandler: 'ES_INVALID_COMMAND_HANDLER',
	InvalidEventStreamName: 'ES_INVALID_EVENT_STREAM_NAME',
	InvalidQueryHandler: 'ES_INVALID_QUERY_HANDLER',
	MissingAggregateMetadata: 'ES_MISSING_AGGREGATE_METADATA',
	MissingCommandHandlerMetadata: 'ES_MISSING_COMMAND_HANDLER_METADATA',
	MissingCommandMetadata: 'ES_MISSING_COMMAND_METADATA',
	MissingEventHandler: 'ES_MISSING_EVENT_HANDLER',
	MissingEventMetadata: 'ES_MISSING_EVENT_METADATA',
	MissingEventPublisherMetadata: 'ES_MISSING_EVENT_PUBLISHER_METADATA',
	MissingEventSerializerMetadata: 'ES_MISSING_EVENT_SERIALIZER_METADATA',
	MissingEventSubscriberMetadata: 'ES_MISSING_EVENT_SUBSCRIBER_METADATA',
	MissingQueryHandlerMetadata: 'ES_MISSING_QUERY_HANDLER_METADATA',
	MissingQueryMetadata: 'ES_MISSING_QUERY_METADATA',
	MissingSnapshotMetadata: 'ES_MISSING_SNAPSHOT_METADATA',
	QueryHandlerNotFound: 'ES_QUERY_HANDLER_NOT_FOUND',
	SnapshotNotFound: 'ES_SNAPSHOT_NOT_FOUND',
	UnregisteredEvent: 'ES_UNREGISTERED_EVENT',
	UnregisteredSerializer: 'ES_UNREGISTERED_SERIALIZER',
	UnsupportedOperation: 'ES_UNSUPPORTED_OPERATION',
	// Domain
	IdAlreadyRegistered: 'ES_ID_ALREADY_REGISTERED',
	IdNotFound: 'ES_ID_NOT_FOUND',
	InvalidId: 'ES_INVALID_ID',
	// Integration
	EventStoreCollectionCreation: 'ES_EVENT_STORE_COLLECTION_CREATION',
	EventStorePersistence: 'ES_EVENT_STORE_PERSISTENCE',
	EventStoreVersionConflict: 'ES_EVENT_STORE_VERSION_CONFLICT',
	SnapshotStoreCollectionCreation: 'ES_SNAPSHOT_STORE_COLLECTION_CREATION',
	SnapshotStorePersistence: 'ES_SNAPSHOT_STORE_PERSISTENCE',
	SnapshotStoreVersionConflict: 'ES_SNAPSHOT_STORE_VERSION_CONFLICT',
} as const;

export type EventSourcingErrorCode = (typeof EventSourcingErrorCode)[keyof typeof EventSourcingErrorCode];

/**
 * Tells whether a value is an error thrown by the library, optionally with a specific code.
 *
 * Prefer it over `instanceof` or comparing constructors: it narrows the type, checks the code in one call and also
 * recognises errors from another copy of the package.
 *
 * @example
 * if (isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)) {
 * 	// retry the command
 * }
 */
export function isEventSourcingError(error: unknown, code?: EventSourcingErrorCode): error is EventSourcingError {
	if (
		typeof error !== 'object' ||
		error === null ||
		(error as Record<symbol, unknown>)[EVENT_SOURCING_ERROR] !== true
	) {
		return false;
	}
	return code === undefined || (error as { code?: unknown }).code === code;
}

/**
 * The base class of every error the library throws (`DomainException`, the base for your own domain errors, excepted).
 *
 * Each subclass has a literal `name` (it survives minification), a unique `code` from {@link EventSourcingErrorCode}
 * and the fields that describe the failure. The underlying error, if any, is the standard `cause`; the stack is never
 * replaced by the cause's stack.
 */
export abstract class EventSourcingError extends Error {
	abstract override readonly name: string;
	abstract readonly code: EventSourcingErrorCode;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}

	/**
	 * `error instanceof EventSourcingError` checks the brand (see {@link isEventSourcingError}), so it also holds for an
	 * `InvalidIdException` and for errors from another copy of the package. Subclasses keep the regular prototype check.
	 */
	static [Symbol.hasInstance](value: unknown): boolean {
		if (this !== EventSourcingError) {
			return Function.prototype[Symbol.hasInstance].call(this, value);
		}
		return isEventSourcingError(value);
	}
}

brandEventSourcingError(EventSourcingError.prototype);
