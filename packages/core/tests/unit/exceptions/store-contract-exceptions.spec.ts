import {
	EventCollectionNotFoundException,
	EventSourcingErrorCode,
	EventStoreSchemaException,
	InvalidAppendOptionsException,
	InvalidEventEnvelopeException,
	InvalidEventMetadataException,
	InvalidEventStoreImplementationException,
	isEventSourcingError,
} from '@ocoda/event-sourcing';

// The exceptions of the v4 store contract (ADR 0001 §1, §8, §9). The table test in exceptions.spec.ts covers what every
// exception shares (literal name, code, cause, stack, construction without details); this covers their fields and
// messages.
describe('store contract exceptions', () => {
	describe(InvalidEventEnvelopeException, () => {
		it('describes a pre-built envelope of another aggregate', () => {
			const error = new InvalidEventEnvelopeException({
				streamId: 'account-1',
				index: 2,
				reason: 'aggregate-id',
				expected: '1',
				actual: '2',
			});

			expect(error).toMatchObject({
				code: EventSourcingErrorCode.InvalidEventEnvelope,
				streamId: 'account-1',
				index: 2,
				reason: 'aggregate-id',
				expected: '1',
				actual: '2',
			});
			expect(error.message).toBe(
				'The item at index 2 belongs to aggregate 2, not to aggregate 1 of the account-1 stream.',
			);
		});

		it('describes a version that does not continue the stream', () => {
			const error = new InvalidEventEnvelopeException({
				streamId: 'account-1',
				index: 0,
				reason: 'version',
				expected: 4,
				actual: 6,
			});

			expect(error.message).toBe(
				'The item at index 0 has version 6, but the append continues the account-1 stream at version 4.',
			);
			expect(new InvalidEventEnvelopeException({ streamId: 'account-1', reason: 'version' }).message).toMatch(
				/^An envelope has version/,
			);
		});

		it('describes pre-built envelopes appended with ExpectedVersion.Any', () => {
			const error = new InvalidEventEnvelopeException({
				streamId: 'account-1',
				index: 0,
				reason: 'expected-version-any',
			});

			expect(error.message).toBe(
				"Pre-built envelopes can't be appended to the account-1 stream with ExpectedVersion.Any: pass the version of the stream before the append.",
			);
		});

		it('describes a value that is too long', () => {
			const error = new InvalidEventEnvelopeException({
				streamId: 'account-1',
				index: 1,
				reason: 'too-long',
				field: 'event',
				expected: 255,
				actual: 300,
			});

			expect(error).toMatchObject({ field: 'event', expected: 255, actual: 300 });
			expect(error.message).toBe(
				'The event of the item at index 1 to the account-1 stream is 300 characters long, the maximum is 255.',
			);
			expect(
				new InvalidEventEnvelopeException({
					streamId: 'account-1',
					reason: 'too-long',
					field: 'streamId',
					expected: 255,
					actual: 256,
				}).message,
			).toBe('The streamId of an append to the account-1 stream is 256 characters long, the maximum is 255.');
			expect(new InvalidEventEnvelopeException({ streamId: 's', reason: 'too-long' }).message).toContain(
				'The value of',
			);
		});

		it('has a generic message without a reason', () => {
			expect(new InvalidEventEnvelopeException(undefined as never).message).toBe(
				'Invalid envelope for the unknown stream.',
			);
		});
	});

	describe(InvalidEventMetadataException, () => {
		it.each([
			[{ field: 'correlationId', reason: 'invalid-type' }, 'Invalid event metadata: correlationId must be a string.'],
			[{ field: 'headers', reason: 'invalid-type' }, 'Invalid event metadata: headers must be a plain object.'],
			[{ field: 'headers', reason: 'empty-key', key: '' }, 'Invalid event metadata: headers has an empty key.'],
			[
				{ field: 'headers', reason: 'reserved-key', key: '$tenant' },
				'Invalid event metadata: the headers key "$tenant" is reserved; keys that start with $ are reserved for the library.',
			],
			[
				{ field: 'headers', reason: 'invalid-value', key: 'nested' },
				'Invalid event metadata: the value of the headers key "nested" must be a string, a finite number, a boolean or null.',
			],
			[
				{ field: 'causationId', reason: 'too-long', limit: 255 },
				'Invalid event metadata: causationId is longer than 255 characters.',
			],
			[
				{ field: 'headers', reason: 'too-large', limit: 8192 },
				'Invalid event metadata: headers are larger than 8192 bytes as JSON.',
			],
		] as const)('describes %o', (details, message) => {
			const error = new InvalidEventMetadataException(details);

			expect(error).toMatchObject({ code: EventSourcingErrorCode.InvalidEventMetadata, ...details });
			expect(error.message).toBe(message);
		});

		it('has a generic message without a reason', () => {
			expect(new InvalidEventMetadataException(undefined as never).message).toBe('Invalid event metadata: metadata.');
			expect(new InvalidEventMetadataException({ field: 'headers', reason: 'too-large' }).message).toContain(
				'the maximum of',
			);
			expect(new InvalidEventMetadataException({ field: 'correlationId', reason: 'too-long' }).message).toContain(
				'the maximum of',
			);
		});
	});

	describe(InvalidAppendOptionsException, () => {
		it('names the option, what it has to be and the value it got', () => {
			const error = new InvalidAppendOptionsException({
				option: 'expectedVersion',
				value: -1,
				reason: 'must be a safe integer of at least 0',
			});

			expect(error).toMatchObject({
				code: EventSourcingErrorCode.InvalidAppendOptions,
				option: 'expectedVersion',
				value: -1,
				reason: 'must be a safe integer of at least 0',
			});
			expect(error.message).toBe(
				'Invalid append option expectedVersion: must be a safe integer of at least 0, got -1.',
			);
		});

		it.each([
			['x', '"x"'],
			[1n, '1n'],
			[null, 'null'],
			[undefined, 'undefined'],
			[[1], 'an array'],
			[{ secret: 'value' }, 'an object'],
			[() => 1, 'a function'],
			[Symbol('pool'), 'Symbol(pool)'],
			[Number.NaN, 'NaN'],
		])('describes the value %o without printing objects', (value, shown) => {
			expect(new InvalidAppendOptionsException({ option: 'pool', value, reason: 'r' }).message).toBe(
				`Invalid append option pool: r, got ${shown}.`,
			);
		});
	});

	describe(EventCollectionNotFoundException, () => {
		it('names the collection and the pool', () => {
			const error = new EventCollectionNotFoundException({ collection: 'tenant-events', pool: 'tenant' });

			expect(error).toMatchObject({
				code: EventSourcingErrorCode.EventCollectionNotFound,
				collection: 'tenant-events',
				pool: 'tenant',
			});
			expect(error.message).toBe(
				'The tenant-events collection of the tenant pool does not exist. Create it with ensureCollection().',
			);
			expect(new EventCollectionNotFoundException({ collection: 'events' }).message).toBe(
				'The events collection does not exist. Create it with ensureCollection().',
			);
		});
	});

	describe(InvalidEventStoreImplementationException, () => {
		it('names the store and the overridden methods', () => {
			const error = new InvalidEventStoreImplementationException({
				store: 'TracingEventStore',
				methods: ['appendEvents', 'getEvents'],
			});

			expect(error).toMatchObject({
				code: EventSourcingErrorCode.InvalidEventStoreImplementation,
				store: 'TracingEventStore',
				methods: ['appendEvents', 'getEvents'],
			});
			expect(error.message).toBe(
				'The event store TracingEventStore overrides appendEvents, getEvents of EventStore. Implement the driver methods instead, and override persistEvents to decorate appends.',
			);
			expect(new InvalidEventStoreImplementationException(undefined as never).methods).toEqual([]);
		});
	});

	describe(EventStoreSchemaException, () => {
		it.each([
			['missing', 'does not exist'],
			['v1', 'has the 3.x schema'],
			['v1-partial', 'has a partly migrated 3.x schema'],
			['unregistered', 'is not registered in the catalog of the store'],
		] as const)('describes a %s collection', (found, description) => {
			const error = new EventStoreSchemaException({
				collection: 'events',
				found,
				remedy: 'Run PostgresEventStore.migrate().',
			});

			expect(isEventSourcingError(error, EventSourcingErrorCode.EventStoreSchema)).toBe(true);
			expect(error).toMatchObject({ collection: 'events', found, remedy: 'Run PostgresEventStore.migrate().' });
			expect(error.message).toBe(`The events collection ${description}. Run PostgresEventStore.migrate().`);
		});

		it('has a generic message without details', () => {
			expect(new EventStoreSchemaException(undefined as never).message).toBe(
				'The unknown collection does not have the expected schema.',
			);
		});
	});
});
