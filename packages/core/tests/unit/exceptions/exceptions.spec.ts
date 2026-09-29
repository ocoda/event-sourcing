import * as EventSourcing from '@ocoda/event-sourcing';
import {
	DomainException,
	EventSourcingError,
	EventSourcingErrorCode,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	InvalidIdException,
	UUID,
	isEventSourcingError,
} from '@ocoda/event-sourcing';

type ErrorClass = new (details?: unknown, options?: ErrorOptions) => Error & { code?: string };

// Every exported error class, found by walking the public entrypoint so that a new export can't skip these checks.
// The two abstract bases are covered separately.
const exported = (Object.entries(EventSourcing) as [string, unknown][])
	.filter(([, value]) => typeof value === 'function' && value.prototype instanceof Error)
	.filter(([, value]) => value !== EventSourcingError && value !== DomainException)
	.map(([key, value]) => [key, value as ErrorClass] as const)
	.sort(([a], [b]) => a.localeCompare(b));

describe('exceptions', () => {
	it('pins the error codes', () => {
		// Renaming or removing a code is a breaking change: users match on them.
		expect(EventSourcingErrorCode).toMatchInlineSnapshot(`
			{
			  "CommandHandlerNotFound": "ES_COMMAND_HANDLER_NOT_FOUND",
			  "EventCollectionNotFound": "ES_EVENT_COLLECTION_NOT_FOUND",
			  "EventNotFound": "ES_EVENT_NOT_FOUND",
			  "EventSerialization": "ES_EVENT_SERIALIZATION",
			  "EventSourcingConfiguration": "ES_EVENT_SOURCING_CONFIGURATION",
			  "EventSourcingNotReady": "ES_EVENT_SOURCING_NOT_READY",
			  "EventStoreCollectionCreation": "ES_EVENT_STORE_COLLECTION_CREATION",
			  "EventStorePersistence": "ES_EVENT_STORE_PERSISTENCE",
			  "EventStoreSchema": "ES_EVENT_STORE_SCHEMA",
			  "EventStoreVersionConflict": "ES_EVENT_STORE_VERSION_CONFLICT",
			  "IdAlreadyRegistered": "ES_ID_ALREADY_REGISTERED",
			  "IdNotFound": "ES_ID_NOT_FOUND",
			  "InvalidAggregateStreamName": "ES_INVALID_AGGREGATE_STREAM_NAME",
			  "InvalidAppendOptions": "ES_INVALID_APPEND_OPTIONS",
			  "InvalidCommandHandler": "ES_INVALID_COMMAND_HANDLER",
			  "InvalidEventEnvelope": "ES_INVALID_EVENT_ENVELOPE",
			  "InvalidEventMetadata": "ES_INVALID_EVENT_METADATA",
			  "InvalidEventStoreImplementation": "ES_INVALID_EVENT_STORE_IMPLEMENTATION",
			  "InvalidEventStreamName": "ES_INVALID_EVENT_STREAM_NAME",
			  "InvalidId": "ES_INVALID_ID",
			  "InvalidQueryHandler": "ES_INVALID_QUERY_HANDLER",
			  "MissingAggregateMetadata": "ES_MISSING_AGGREGATE_METADATA",
			  "MissingCommandHandlerMetadata": "ES_MISSING_COMMAND_HANDLER_METADATA",
			  "MissingCommandMetadata": "ES_MISSING_COMMAND_METADATA",
			  "MissingEventHandler": "ES_MISSING_EVENT_HANDLER",
			  "MissingEventMetadata": "ES_MISSING_EVENT_METADATA",
			  "MissingEventPublisherMetadata": "ES_MISSING_EVENT_PUBLISHER_METADATA",
			  "MissingEventSerializerMetadata": "ES_MISSING_EVENT_SERIALIZER_METADATA",
			  "MissingEventSubscriberMetadata": "ES_MISSING_EVENT_SUBSCRIBER_METADATA",
			  "MissingQueryHandlerMetadata": "ES_MISSING_QUERY_HANDLER_METADATA",
			  "MissingQueryMetadata": "ES_MISSING_QUERY_METADATA",
			  "MissingSnapshotMetadata": "ES_MISSING_SNAPSHOT_METADATA",
			  "QueryHandlerNotFound": "ES_QUERY_HANDLER_NOT_FOUND",
			  "SnapshotNotFound": "ES_SNAPSHOT_NOT_FOUND",
			  "SnapshotStoreCollectionCreation": "ES_SNAPSHOT_STORE_COLLECTION_CREATION",
			  "SnapshotStorePersistence": "ES_SNAPSHOT_STORE_PERSISTENCE",
			  "SnapshotStoreVersionConflict": "ES_SNAPSHOT_STORE_VERSION_CONFLICT",
			  "UncommittedEvents": "ES_UNCOMMITTED_EVENTS",
			  "UnregisteredEvent": "ES_UNREGISTERED_EVENT",
			  "UnregisteredSerializer": "ES_UNREGISTERED_SERIALIZER",
			  "UnsupportedOperation": "ES_UNSUPPORTED_OPERATION",
			}
		`);
	});

	it('gives every exported exception its own code', () => {
		const codes = Object.fromEntries(exported.map(([key, Exception]) => [key, new Exception(undefined).code]));

		expect(codes).toMatchInlineSnapshot(`
			{
			  "CommandHandlerNotFoundException": "ES_COMMAND_HANDLER_NOT_FOUND",
			  "EventCollectionNotFoundException": "ES_EVENT_COLLECTION_NOT_FOUND",
			  "EventNotFoundException": "ES_EVENT_NOT_FOUND",
			  "EventSerializationException": "ES_EVENT_SERIALIZATION",
			  "EventSourcingConfigurationException": "ES_EVENT_SOURCING_CONFIGURATION",
			  "EventSourcingNotReadyException": "ES_EVENT_SOURCING_NOT_READY",
			  "EventStoreCollectionCreationException": "ES_EVENT_STORE_COLLECTION_CREATION",
			  "EventStorePersistenceException": "ES_EVENT_STORE_PERSISTENCE",
			  "EventStoreSchemaException": "ES_EVENT_STORE_SCHEMA",
			  "EventStoreVersionConflictException": "ES_EVENT_STORE_VERSION_CONFLICT",
			  "IdAlreadyRegisteredException": "ES_ID_ALREADY_REGISTERED",
			  "IdNotFoundException": "ES_ID_NOT_FOUND",
			  "InvalidAggregateStreamNameException": "ES_INVALID_AGGREGATE_STREAM_NAME",
			  "InvalidAppendOptionsException": "ES_INVALID_APPEND_OPTIONS",
			  "InvalidCommandHandlerException": "ES_INVALID_COMMAND_HANDLER",
			  "InvalidEventEnvelopeException": "ES_INVALID_EVENT_ENVELOPE",
			  "InvalidEventMetadataException": "ES_INVALID_EVENT_METADATA",
			  "InvalidEventStoreImplementationException": "ES_INVALID_EVENT_STORE_IMPLEMENTATION",
			  "InvalidEventStreamNameException": "ES_INVALID_EVENT_STREAM_NAME",
			  "InvalidIdException": "ES_INVALID_ID",
			  "InvalidQueryHandlerException": "ES_INVALID_QUERY_HANDLER",
			  "MissingAggregateMetadataException": "ES_MISSING_AGGREGATE_METADATA",
			  "MissingCommandHandlerMetadataException": "ES_MISSING_COMMAND_HANDLER_METADATA",
			  "MissingCommandMetadataException": "ES_MISSING_COMMAND_METADATA",
			  "MissingEventHandlerException": "ES_MISSING_EVENT_HANDLER",
			  "MissingEventMetadataException": "ES_MISSING_EVENT_METADATA",
			  "MissingEventPublisherMetadataException": "ES_MISSING_EVENT_PUBLISHER_METADATA",
			  "MissingEventSerializerMetadataException": "ES_MISSING_EVENT_SERIALIZER_METADATA",
			  "MissingEventSubscriberMetadataException": "ES_MISSING_EVENT_SUBSCRIBER_METADATA",
			  "MissingQueryHandlerMetadataException": "ES_MISSING_QUERY_HANDLER_METADATA",
			  "MissingQueryMetadataException": "ES_MISSING_QUERY_METADATA",
			  "MissingSnapshotMetadataException": "ES_MISSING_SNAPSHOT_METADATA",
			  "QueryHandlerNotFoundException": "ES_QUERY_HANDLER_NOT_FOUND",
			  "SnapshotNotFoundException": "ES_SNAPSHOT_NOT_FOUND",
			  "SnapshotStoreCollectionCreationException": "ES_SNAPSHOT_STORE_COLLECTION_CREATION",
			  "SnapshotStorePersistenceException": "ES_SNAPSHOT_STORE_PERSISTENCE",
			  "SnapshotStoreVersionConflictException": "ES_SNAPSHOT_STORE_VERSION_CONFLICT",
			  "UncommittedEventsException": "ES_UNCOMMITTED_EVENTS",
			  "UnregisteredEventException": "ES_UNREGISTERED_EVENT",
			  "UnregisteredSerializerException": "ES_UNREGISTERED_SERIALIZER",
			  "UnsupportedOperationException": "ES_UNSUPPORTED_OPERATION",
			}
		`);
		expect(new Set(Object.values(codes)).size).toBe(exported.length);
		expect(Object.values(codes).sort()).toEqual(Object.values(EventSourcingErrorCode).sort());
	});

	describe.each(exported)('%s', (key, Exception) => {
		it('can be constructed without details', () => {
			expect(() => new Exception(undefined)).not.toThrow();
			expect(() => new Exception({})).not.toThrow();
			expect(new Exception(undefined).message).toEqual(expect.any(String));
		});

		it('has a literal name', () => {
			const error = new Exception(undefined);

			// The export name, not Exception.name, which a minifier may rename
			expect(error.name).toBe(key);
			expect(String(error)).toBe(`${key}: ${error.message}`);
		});

		it('is an event-sourcing error with its code', () => {
			const error = new Exception(undefined);

			expect(error).toBeInstanceOf(Exception);
			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(EventSourcingError);
			expect(isEventSourcingError(error)).toBe(true);
			expect(isEventSourcingError(error, error.code as EventSourcingErrorCode)).toBe(true);
			expect(Object.values(EventSourcingErrorCode)).toContain(error.code);
		});

		it('keeps the cause and its own stack', () => {
			const cause = new Error('driver failure');
			const error = new Exception(undefined, { cause });

			expect(error.cause).toBe(cause);
			expect(error.stack).toEqual(expect.any(String));
			expect(error.stack).not.toBe(cause.stack);
			expect(error.stack?.startsWith(`${key}: ${error.message}`)).toBe(true);
			expect(error.stack).toContain('exceptions.spec.ts');
		});
	});

	describe(isEventSourcingError, () => {
		it('rejects values that are not event-sourcing errors', () => {
			for (const value of [
				undefined,
				null,
				0,
				'ES_EVENT_NOT_FOUND',
				{},
				new Error('x'),
				{ code: 'ES_EVENT_NOT_FOUND' },
			]) {
				expect(isEventSourcingError(value)).toBe(false);
				expect(value instanceof EventSourcingError).toBe(false);
			}
		});

		it('matches on the code', () => {
			const error = new EventStorePersistenceException({ collection: 'events', outcome: 'unknown' });

			expect(isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)).toBe(true);
			expect(isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)).toBe(false);
		});

		it('recognises errors from another copy of the package', async () => {
			vi.resetModules();
			const copy = await import('@ocoda/event-sourcing');
			expect(copy.EventStoreVersionConflictException).not.toBe(EventStoreVersionConflictException);

			const error = new copy.EventStorePersistenceException({ collection: 'events', outcome: 'unknown' });

			expect(isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)).toBe(true);
			expect(error).toBeInstanceOf(EventSourcingError);
			// Subclasses keep the regular prototype check
			expect(error).not.toBeInstanceOf(EventStorePersistenceException);
		});
	});

	describe(EventStoreVersionConflictException, () => {
		@EventSourcing.Aggregate({ streamName: 'account' })
		class Account extends EventSourcing.AggregateRoot {}

		it('describes the conflict in its fields', () => {
			const id = UUID.generate();
			const stream = EventStream.for(Account, id);
			const cause = new Error('duplicate key');
			const error = new EventStoreVersionConflictException(
				{ stream, expectedVersion: 3, actualVersion: 5, pool: 'tenant' },
				{ cause },
			);

			expect(error).toMatchObject({
				name: 'EventStoreVersionConflictException',
				code: 'ES_EVENT_STORE_VERSION_CONFLICT',
				streamId: `account-${id.value}`,
				aggregateId: id.value,
				pool: 'tenant',
				expectedVersion: 3,
				actualVersion: 5,
				cause,
			});
			expect(error.message).toContain('expected version 3');
		});

		it('narrows through instanceof and isEventSourcingError', () => {
			const stream = EventStream.for(Account, UUID.generate());
			const error: unknown = new EventStoreVersionConflictException({ stream, expectedVersion: 1, actualVersion: 2 });

			if (error instanceof EventStoreVersionConflictException) {
				expectTypeOf(error.expectedVersion).toEqualTypeOf<EventSourcing.ExpectedVersion>();
			}
			if (error instanceof EventSourcingError) {
				expectTypeOf(error.code).toEqualTypeOf<EventSourcingErrorCode>();
			}
			if (isEventSourcingError(error)) {
				expectTypeOf(error).toEqualTypeOf<EventSourcingError>();
			}
			// A code narrows to the exception class of that code, so its fields are available
			if (isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)) {
				expectTypeOf(error).toEqualTypeOf<EventStoreVersionConflictException>();
				expectTypeOf(error.actualVersion).toEqualTypeOf<number | undefined>();
			}
			if (isEventSourcingError(error, EventSourcingErrorCode.InvalidId)) {
				expectTypeOf(error).toEqualTypeOf<InvalidIdException>();
			}
			const code = EventSourcingErrorCode.EventStorePersistence as EventSourcingErrorCode | undefined;
			if (isEventSourcingError(error, code)) {
				expectTypeOf(error).toEqualTypeOf<EventSourcingError>();
			}
			expect.assertions(0);
		});

		it('maps every code to its exception class', () => {
			// A new code without an entry in EventSourcingErrorByCode fails to compile here
			expectTypeOf<keyof EventSourcing.EventSourcingErrorByCode>().toEqualTypeOf<EventSourcingErrorCode>();

			const stream = EventStream.for(Account, UUID.generate());
			const errors: EventSourcing.EventSourcingErrorByCode[EventSourcingErrorCode][] = [
				new EventStoreVersionConflictException({ stream, expectedVersion: 1 }),
				new InvalidIdException(),
			];
			for (const error of errors) {
				expect(isEventSourcingError(error, error.code)).toBe(true);
			}
		});

		it('leaves the actual version unknown after a lost race', () => {
			const stream = EventStream.for(Account, UUID.generate());
			const error = new EventStoreVersionConflictException({ stream, expectedVersion: 0 });

			expect(error.actualVersion).toBeUndefined();
			expect(error.pool).toBeUndefined();
		});
	});

	describe(EventStorePersistenceException, () => {
		it("defaults the outcome to 'unknown'", () => {
			expect(new EventStorePersistenceException(undefined as never).outcome).toBe('unknown');
			expect(new EventStorePersistenceException({ collection: 'events', outcome: 'not-persisted' }).outcome).toBe(
				'not-persisted',
			);
		});
	});

	describe(DomainException, () => {
		class AccountClosedException extends DomainException {
			static because(id: UUID, cause?: unknown) {
				return new AccountClosedException('Account is closed', id, { cause });
			}
		}

		it('gets the name of the subclass and keeps the cause, without a code', () => {
			const id = UUID.generate();
			const cause = new Error('closed');
			const error = AccountClosedException.because(id, cause);

			expect(error.name).toBe('AccountClosedException');
			expect(error.id).toBe(id);
			expect(error.cause).toBe(cause);
			expect(error).not.toHaveProperty('code');
			expect(isEventSourcingError(error)).toBe(false);
			expect(error).not.toBeInstanceOf(EventSourcingError);
			// Not enumerable, like the name of an Error: the error serializes as in 3.x
			expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty('name');
		});

		it('keeps a name the subclass defines itself', () => {
			// A getter-only or read-only name on the prototype can't be assigned to
			class GetterNameException extends DomainException {
				constructor() {
					super('getter');
				}
			}
			Object.defineProperty(GetterNameException.prototype, 'name', { get: () => 'CustomGetterName' });
			class PrototypeNameException extends DomainException {
				constructor() {
					super('prototype');
				}
			}
			Object.defineProperty(PrototypeNameException.prototype, 'name', { value: 'CustomPrototypeName' });
			class FieldNameException extends DomainException {
				override readonly name = 'CustomFieldName';
				constructor() {
					super('field');
				}
			}

			expect(new GetterNameException().name).toBe('CustomGetterName');
			expect(new PrototypeNameException().name).toBe('CustomPrototypeName');
			expect(new FieldNameException().name).toBe('CustomFieldName');
		});
	});

	describe(InvalidIdException, () => {
		it('stays a DomainException', () => {
			const error = new InvalidIdException({ value: 'nope', idType: 'UUID' });

			expect(error).toBeInstanceOf(DomainException);
			expect(error).toBeInstanceOf(EventSourcingError);
			expect(isEventSourcingError(error, EventSourcingErrorCode.InvalidId)).toBe(true);
			expect(error.message).toBe("'nope' is not a valid UUID.");
		});

		it('keeps the deprecated factories', () => {
			expect(InvalidIdException.becauseEmpty()).toBeInstanceOf(InvalidIdException);
			expect(InvalidIdException.becauseInvalid('nope').message).toBe("'nope' is not a valid UUID.");
			expect(InvalidIdException.because('custom reason').message).toBe('custom reason');
		});

		it('keeps the deprecated 3.x constructor for subclasses', () => {
			class InvalidAccountIdException extends InvalidIdException {
				constructor(id: UUID, cause?: unknown) {
					super('Not an account id', id, { cause });
				}
			}
			const id = UUID.generate();
			const cause = new Error('checksum');
			const error = new InvalidAccountIdException(id, cause);

			expect(error).toBeInstanceOf(InvalidIdException);
			expect(error).toMatchObject({
				name: 'InvalidIdException',
				code: EventSourcingErrorCode.InvalidId,
				message: 'Not an account id',
				id,
				cause,
			});
			expect(error.value).toBeUndefined();
		});
	});
});
