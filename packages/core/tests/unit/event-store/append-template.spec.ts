import { Logger } from '@nestjs/common';
import {
	ANY_MAX_ATTEMPTS,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventSourcingErrorCode,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	ExpectedVersion,
	InvalidAppendOptionsException,
	InvalidEventEnvelopeException,
	InvalidEventMetadataException,
	UnregisteredEventException,
	UnsupportedOperationException,
} from '@ocoda/event-sourcing';
import { Account, AccountId, getEvents } from '@ocoda/event-sourcing-testing/unit';
import type { MockInstance } from 'vitest';
import { resetPositionalAppendWarning } from '../../../lib/stores/append-arguments.js';
import { createStubStore } from './stub-event-store.js';

const events = getEvents();
const newStream = () => EventStream.for(Account, AccountId.generate());

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(error: unknown) => error,
	);

const versionsOf = (envelopes: readonly EventEnvelope[]) => envelopes.map(({ metadata }) => metadata.version);

describe('EventStore.appendEvents', () => {
	let loggerError: MockInstance;

	beforeEach(() => {
		loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		// No backoff between the attempts of ExpectedVersion.Any
		vi.spyOn(Math, 'random').mockReturnValue(0);
	});

	describe('an append', () => {
		it('serializes the events, stores them after the expected version, stamps the positions and publishes them', async () => {
			const { store, publishAll, eventMap } = createStubStore();
			const stream = newStream();
			store.head = 2;

			const envelopes = await store.appendEvents(stream, events.slice(0, 3), { expectedVersion: 2, pool: 'tenant' });

			expect(store.headReads).toEqual([[stream, 'tenant']]);
			expect(store.persisted).toHaveLength(1);
			const [persisted, target] = store.persisted[0];
			expect(target).toEqual({ stream, collection: 'tenant-events', expectedVersion: 2, pool: 'tenant' });
			expect(versionsOf(persisted)).toEqual([3, 4, 5]);
			expect(persisted.map(({ metadata }) => metadata.globalPosition)).toEqual([undefined, undefined, undefined]);

			expect(envelopes.map(({ event }) => event)).toEqual(events.slice(0, 3).map((event) => eventMap.getName(event)));
			expect(envelopes.map(({ payload }) => payload)).toEqual(
				events.slice(0, 3).map((event) => eventMap.serializeEvent(event)),
			);
			expect(versionsOf(envelopes)).toEqual([3, 4, 5]);
			expect(envelopes.map(({ metadata }) => metadata.globalPosition)).toEqual([1n, 2n, 3n]);
			for (const { metadata } of envelopes) {
				expect(metadata.aggregateId).toBe(stream.aggregateId);
				expect(metadata.eventId).toBeInstanceOf(EventId);
				expect(metadata.occurredOn).toEqual(metadata.eventId.date);
				expect(Object.keys(metadata).sort()).toEqual(
					['aggregateId', 'eventId', 'globalPosition', 'occurredOn', 'version'].sort(),
				);
			}
			expect(publishAll).toHaveBeenCalledTimes(1);
			expect(publishAll.mock.calls[0][0]).toBe(envelopes);
		});

		it('gives the events of the appends of a store ids from one monotonic factory', async () => {
			const { store } = createStubStore();
			const stream = newStream();

			const first = await store.appendEvents(stream, events.slice(0, 3), { expectedVersion: 0 });
			store.head = 3;
			const second = await store.appendEvents(stream, events.slice(3), { expectedVersion: 3 });

			const ids = [...first, ...second].map(({ metadata }) => metadata.eventId.value);
			expect([...ids].sort()).toEqual(ids);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it('returns no envelopes for an empty append, without any I/O', async () => {
			const { store, publishAll } = createStubStore();

			await expect(store.appendEvents(newStream(), [], { expectedVersion: 7 })).resolves.toEqual([]);
			await expect(store.appendEvents(newStream(), [], { expectedVersion: ExpectedVersion.Any })).resolves.toEqual([]);
			await expect(store.appendEvents(newStream(), 3, [])).resolves.toEqual([]);

			expect(store.headReads).toEqual([]);
			expect(store.persisted).toEqual([]);
			expect(publishAll).not.toHaveBeenCalled();
		});

		it('applies the metadata of the options to every event, and stores no empty headers', async () => {
			const { store } = createStubStore();
			const metadata = { correlationId: 'correlation', causationId: 'causation', headers: { tenant: 'acme' } };

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, metadata });
			for (const envelope of envelopes) {
				expect(envelope.metadata).toMatchObject(metadata);
			}

			const [withoutHeaders] = await store.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				metadata: { headers: {}, correlationId: undefined },
			});
			expect(Object.hasOwn(withoutHeaders.metadata, 'headers')).toBe(false);
			expect(Object.hasOwn(withoutHeaders.metadata, 'correlationId')).toBe(false);
		});

		it('publishes nothing when publish is false', async () => {
			const { store, publishAll } = createStubStore();

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				publish: false,
			});

			expect(envelopes).toHaveLength(1);
			expect(publishAll).not.toHaveBeenCalled();
		});

		it.each([
			['rejects', (error: Error) => Promise.reject(error)],
			[
				'throws',
				(error: Error) => {
					throw error;
				},
			],
		])('resolves and logs when the publisher %s', async (_description, fail) => {
			const { store, publishAll } = createStubStore();
			publishAll.mockImplementation(() => fail(new Error('broker down')));

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0 });

			expect(envelopes).toHaveLength(2);
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to publish 2 appended event(s)',
				expect.stringContaining('broker down'),
			);
		});
	});

	describe('pre-built envelopes', () => {
		it('keeps their id, time and metadata, fills the fields they lack, and leaves them as they were', async () => {
			const { store, eventMap } = createStubStore();
			const stream = newStream();
			const occurredOn = new Date('2020-01-02T03:04:05.678Z');
			const imported = EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: stream.aggregateId,
				version: 1,
				eventId: EventId.generate(occurredOn),
				correlationId: 'own-correlation',
				headers: { $traceparent: '00-a-b-01' },
				eventVersion: 3,
			}).withGlobalPosition(99n);
			const before = JSON.stringify(imported);

			const [stored, raw] = await store.appendEvents(stream, [imported, events[1]], {
				expectedVersion: 0,
				metadata: { correlationId: 'options', causationId: 'options-causation', headers: { tenant: 'b' } },
			});

			expect(JSON.stringify(imported)).toBe(before);
			expect(stored).not.toBe(imported);
			expect(stored.metadata).toEqual({
				eventId: imported.metadata.eventId,
				aggregateId: stream.aggregateId,
				version: 1,
				occurredOn,
				correlationId: 'own-correlation',
				causationId: 'options-causation',
				// Headers are one field: an envelope with headers keeps its own, without the options' merged in
				headers: { $traceparent: '00-a-b-01' },
				eventVersion: 3,
				// The incoming position is ignored
				globalPosition: 1n,
			});
			expect(raw.metadata).toMatchObject({ correlationId: 'options', headers: { tenant: 'b' }, globalPosition: 2n });
			expect(store.persisted[0][0][0].metadata.globalPosition).toBeUndefined();
		});

		it('fills the headers of an envelope that has none, or empty ones', async () => {
			const { store, eventMap } = createStubStore();
			const stream = newStream();
			const withEmptyHeaders = EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: stream.aggregateId,
				version: 1,
				headers: {},
			});

			const [stored] = await store.appendEvents(stream, [withEmptyHeaders], {
				expectedVersion: 0,
				metadata: { headers: { tenant: 'a' } },
			});

			expect(stored.metadata.headers).toEqual({ tenant: 'a' });
		});
	});

	describe('validation, before any I/O', () => {
		const expectNoIo = (store: ReturnType<typeof createStubStore>['store'], publishAll: MockInstance) => {
			expect(store.headReads).toEqual([]);
			expect(store.persisted).toEqual([]);
			expect(publishAll).not.toHaveBeenCalled();
		};

		it.each<[string, unknown[], Record<string, unknown>]>([
			['no options', [events], { option: 'options' }],
			['options that are not an object', [events, 'any'], { option: 'options' }],
			['a negative expected version', [events, { expectedVersion: -1 }], { option: 'expectedVersion' }],
			['a fractional expected version', [events, { expectedVersion: 1.5 }], { option: 'expectedVersion' }],
			['a missing expected version', [events, {}], { option: 'expectedVersion' }],
			['an empty pool', [events, { expectedVersion: 0, pool: '' }], { option: 'pool' }],
			['a pool that is not a string', [events, { expectedVersion: 0, pool: 1 }], { option: 'pool' }],
			['a publish flag that is not a boolean', [events, { expectedVersion: 0, publish: 'no' }], { option: 'publish' }],
			['events that are not an array', [events[0], { expectedVersion: 0 }], { option: 'events' }],
			['an item that is not an object', [[events[0], null], { expectedVersion: 0 }], { option: 'events' }],
			['metadata that is not an object', [events, { expectedVersion: 0, metadata: 'x' }], { option: 'metadata' }],
			['an aggregate version below the number of events', [1, events.slice(0, 2)], { option: 'aggregateVersion' }],
			['a fractional aggregate version', [2.5, events.slice(0, 2)], { option: 'aggregateVersion' }],
			['an invalid pool in the positional form', [2, events.slice(0, 2), ''], { option: 'pool' }],
		])('rejects %s with an InvalidAppendOptionsException', async (_description, args, fields) => {
			const { store, publishAll } = createStubStore();

			const error = await rejectionOf(store.appendEvents(newStream(), ...(args as [never, never])));

			expect(error).toBeInstanceOf(InvalidAppendOptionsException);
			expect(error).toMatchObject(fields);
			expectNoIo(store, publishAll);
		});

		it.each<[string, unknown, Record<string, unknown>]>([
			['a reserved header key', { headers: { $tenant: 'a' } }, { field: 'headers', reason: 'reserved-key' }],
			['a header value that is an object', { headers: { a: {} } }, { field: 'headers', reason: 'invalid-value' }],
			['headers over 8 KiB', { headers: { a: 'x'.repeat(8192) } }, { field: 'headers', reason: 'too-large' }],
			['a correlation id over 255 characters', { correlationId: 'x'.repeat(256) }, { field: 'correlationId' }],
		])('rejects %s with an InvalidEventMetadataException', async (_description, metadata, fields) => {
			const { store, publishAll } = createStubStore();

			const error = await rejectionOf(
				store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, metadata: metadata as never }),
			);

			expect(error).toBeInstanceOf(InvalidEventMetadataException);
			expect(error).toMatchObject(fields);
			expectNoIo(store, publishAll);
		});

		it('rejects headers on a store without the headers capability, also on pre-built envelopes', async () => {
			const { store, publishAll, eventMap } = createStubStore({ headers: false });
			const stream = newStream();
			const prebuilt = EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: stream.aggregateId,
				version: 1,
				headers: { $traceparent: 'x' },
			});

			for (const append of [
				store.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, metadata: { headers: { a: 'b' } } }),
				store.appendEvents(stream, [prebuilt], { expectedVersion: 0 }),
			]) {
				const error = await rejectionOf(append);
				expect(error).toBeInstanceOf(UnsupportedOperationException);
				expect(error).toMatchObject({ operation: 'headers', component: 'StubEventStore' });
			}
			// Invalid headers are invalid on every store, whatever its capabilities
			await expect(
				store.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, metadata: { headers: { $a: 'b' } } }),
			).rejects.toBeInstanceOf(InvalidEventMetadataException);
			expectNoIo(store, publishAll);
		});

		it('rejects pre-built envelopes that do not continue the stream with an InvalidEventEnvelopeException', async () => {
			const { store, publishAll, eventMap } = createStubStore();
			const stream = newStream();
			const envelope = (version: number, aggregateId = stream.aggregateId) =>
				EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), { aggregateId, version });

			const cases: [unknown[], ExpectedVersion, Record<string, unknown>][] = [
				[[envelope(2)], 0, { reason: 'version', expected: 1, actual: 2 }],
				[[events[0], envelope(3)], 0, { reason: 'version', index: 1, expected: 2, actual: 3 }],
				[[envelope(1, 'another')], 0, { reason: 'aggregate-id', expected: stream.aggregateId, actual: 'another' }],
				[[envelope(1)], ExpectedVersion.Any, { reason: 'expected-version-any' }],
			];
			for (const [items, expectedVersion, fields] of cases) {
				const error = await rejectionOf(store.appendEvents(stream, items as never[], { expectedVersion }));
				expect(error).toBeInstanceOf(InvalidEventEnvelopeException);
				expect(error).toMatchObject({ streamId: stream.streamId, ...fields });
			}
			// The positional form checks them too
			await expect(store.appendEvents(stream, 3, [envelope(2)])).rejects.toBeInstanceOf(InvalidEventEnvelopeException);
			expectNoIo(store, publishAll);
		});

		it('rejects an event name over 255 characters', async () => {
			const { store, publishAll } = createStubStore();
			const stream = newStream();
			const envelope = EventEnvelope.create('e'.repeat(256), {}, { aggregateId: stream.aggregateId, version: 1 });

			const error = await rejectionOf(store.appendEvents(stream, [envelope], { expectedVersion: 0 }));

			expect(error).toBeInstanceOf(InvalidEventEnvelopeException);
			expect(error).toMatchObject({ reason: 'too-long', field: 'event', index: 0, expected: 255, actual: 256 });
			expectNoIo(store, publishAll);
		});

		it('lets serialization errors through', async () => {
			const { store, publishAll } = createStubStore();
			class NotRegistered {}

			await expect(
				store.appendEvents(newStream(), [new NotRegistered()], { expectedVersion: 0 }),
			).rejects.toBeInstanceOf(UnregisteredEventException);
			expectNoIo(store, publishAll);
		});

		it('checks the options before the metadata, and the metadata before the envelopes', async () => {
			const { store, eventMap } = createStubStore();
			const stream = newStream();
			const misplaced = EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: stream.aggregateId,
				version: 5,
			});

			await expect(
				store.appendEvents(stream, [misplaced], { expectedVersion: -1, metadata: { headers: { $a: 'b' } } }),
			).rejects.toBeInstanceOf(InvalidAppendOptionsException);
			await expect(
				store.appendEvents(stream, [misplaced], { expectedVersion: 0, metadata: { headers: { $a: 'b' } } }),
			).rejects.toBeInstanceOf(InvalidEventMetadataException);
			await expect(store.appendEvents(stream, [misplaced], { expectedVersion: 0 })).rejects.toBeInstanceOf(
				InvalidEventEnvelopeException,
			);
		});
	});

	describe('the expected version', () => {
		it.each([
			['older', 5, 3],
			['newer (a gap)', 3, 5],
			['new stream expected, existing stream found', 2, 0],
		])(
			'throws a conflict when the stream is %s than expected, writing nothing',
			async (_description, head, expected) => {
				const { store, publishAll } = createStubStore();
				const stream = newStream();
				store.head = head;

				const error = await rejectionOf(
					store.appendEvents(stream, events.slice(0, 1), { expectedVersion: expected, pool: 'p' }),
				);

				expect(error).toBeInstanceOf(EventStoreVersionConflictException);
				expect(error).toMatchObject({
					code: EventSourcingErrorCode.EventStoreVersionConflict,
					streamId: stream.streamId,
					pool: 'p',
					expectedVersion: expected,
					actualVersion: head,
				});
				expect(store.persisted).toEqual([]);
				expect(publishAll).not.toHaveBeenCalled();
			},
		);

		it('turns a failure to read the version into a not-persisted persistence exception', async () => {
			const { store } = createStubStore();
			const failure = new Error('connection refused');
			store.head = () => Promise.reject(failure);

			const error = await rejectionOf(store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 }));

			expect(error).toBeInstanceOf(EventStorePersistenceException);
			expect(error).toMatchObject({ collection: 'events', outcome: 'not-persisted', cause: failure });
			expect(store.persisted).toEqual([]);
		});

		it.each([['3'], [-1], [1.5], [undefined]])(
			'turns a version that is not a stream version (%s) into a not-persisted persistence exception',
			async (head) => {
				const { store } = createStubStore();
				store.head = () => head;

				const error = await rejectionOf(store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 }));

				expect(error).toBeInstanceOf(EventStorePersistenceException);
				expect(error).toMatchObject({ outcome: 'not-persisted', cause: expect.any(TypeError) });
				expect(store.persisted).toEqual([]);
			},
		);
	});

	describe('the outcome of persistEvents', () => {
		it('lets its EventStorePersistenceException through', async () => {
			const { store, publishAll } = createStubStore();
			for (const outcome of ['not-persisted', 'unknown'] as const) {
				const failure = new EventStorePersistenceException({ collection: 'events', outcome });
				store.outcome = () => Promise.reject(failure);

				await expect(store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 })).rejects.toBe(failure);
			}
			expect(publishAll).not.toHaveBeenCalled();
		});

		it('turns any other error into an unknown outcome', async () => {
			const { store } = createStubStore();
			const failure = new Error('socket hang up');
			store.outcome = () => Promise.reject(failure);

			const error = await rejectionOf(store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 }));

			expect(error).toBeInstanceOf(EventStorePersistenceException);
			expect(error).toMatchObject({ collection: 'events', outcome: 'unknown', cause: failure });
		});

		it.each([[undefined], [null], [{ status: 'done' }], ['committed']])(
			'turns a result that is not an outcome (%s) into an unknown outcome',
			async (outcome) => {
				const { store, publishAll } = createStubStore();
				store.outcome = () => outcome;

				const error = await rejectionOf(store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 }));

				expect(error).toBeInstanceOf(EventStorePersistenceException);
				expect(error).toMatchObject({ outcome: 'unknown', cause: expect.any(TypeError) });
				expect(publishAll).not.toHaveBeenCalled();
			},
		);

		it('throws a conflict with the cause, without retrying or reading again, and publishes nothing', async () => {
			const { store, publishAll } = createStubStore();
			const stream = newStream();
			const cause = new Error('duplicate key');
			store.outcome = () => ({ status: 'conflict', actualVersion: 1, cause });

			const error = await rejectionOf(store.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0 }));

			expect(error).toBeInstanceOf(EventStoreVersionConflictException);
			expect(error).toMatchObject({ expectedVersion: 0, actualVersion: 1, cause });
			expect(store.headReads).toHaveLength(1);
			expect(store.persisted).toHaveLength(1);
			expect(publishAll).not.toHaveBeenCalled();
		});

		it('logs positions that are missing or not bigints, and returns the envelopes without them', async () => {
			const { store, publishAll } = createStubStore();
			for (const positions of [undefined, [1n], [1, 2]]) {
				store.outcome = () => ({ status: 'committed', positions });

				const envelopes = await store.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0 });

				expect(envelopes.map(({ metadata }) => metadata.globalPosition)).toEqual([undefined, undefined]);
			}
			expect(loggerError).toHaveBeenCalledTimes(3);
			expect(publishAll).toHaveBeenCalledTimes(3);
		});

		it('logs positions that do not strictly increase, and stamps them anyway', async () => {
			const { store } = createStubStore();
			store.outcome = () => ({ status: 'committed', positions: [5n, 5n] });

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0 });

			expect(envelopes.map(({ metadata }) => metadata.globalPosition)).toEqual([5n, 5n]);
			expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("don't strictly increase: 5, 5"));
		});
	});

	describe('ExpectedVersion.Any', () => {
		it('appends after the version it reads', async () => {
			const { store } = createStubStore();
			store.head = 4;

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 2), {
				expectedVersion: ExpectedVersion.Any,
			});

			expect(versionsOf(envelopes)).toEqual([5, 6]);
			expect(store.persisted[0][1].expectedVersion).toBe(4);
		});

		it('retries a conflict with the same ids, renumbered after the version it reads again', async () => {
			const { store, publishAll } = createStubStore();
			let head = 0;
			store.head = () => head;
			let conflicts = 3;
			store.outcome = (envelopes) => {
				if (conflicts-- > 0) {
					head += 2;
					return { status: 'conflict' };
				}
				return { status: 'committed', positions: envelopes.map((_, index) => BigInt(index + 1)) };
			};

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 2), {
				expectedVersion: ExpectedVersion.Any,
			});

			expect(store.persisted.map(([persisted]) => versionsOf(persisted))).toEqual([
				[1, 2],
				[3, 4],
				[5, 6],
				[7, 8],
			]);
			const ids = store.persisted.map(([persisted]) => persisted.map(({ metadata }) => metadata.eventId.value));
			expect(new Set(ids.map((attempt) => attempt.join()))).toHaveProperty('size', 1);
			const times = store.persisted.map(([persisted]) => persisted[0].metadata.occurredOn);
			expect(new Set(times)).toHaveProperty('size', 1);
			expect(versionsOf(envelopes)).toEqual([7, 8]);
			expect(publishAll).toHaveBeenCalledTimes(1);
		});

		it(`gives up after ${ANY_MAX_ATTEMPTS} attempts with a conflict`, async () => {
			const { store, publishAll } = createStubStore();
			const stream = newStream();
			const cause = new Error('duplicate key');
			store.outcome = () => ({ status: 'conflict', cause });

			const error = await rejectionOf(
				store.appendEvents(stream, events.slice(0, 1), { expectedVersion: ExpectedVersion.Any, pool: 'p' }),
			);

			expect(error).toBeInstanceOf(EventStoreVersionConflictException);
			expect(error).toMatchObject({ expectedVersion: ExpectedVersion.Any, actualVersion: undefined, pool: 'p', cause });
			expect(store.persisted).toHaveLength(ANY_MAX_ATTEMPTS);
			expect(store.headReads).toHaveLength(ANY_MAX_ATTEMPTS);
			expect(publishAll).not.toHaveBeenCalled();
		});

		it('backs off for a random time of at most 100 ms between attempts', async () => {
			const { store } = createStubStore();
			const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
			let conflicts = 1;
			store.outcome = (envelopes) =>
				conflicts-- > 0
					? { status: 'conflict' }
					: { status: 'committed', positions: envelopes.map((_, index) => BigInt(index + 1)) };

			const started = performance.now();
			await store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: ExpectedVersion.Any });

			expect(random).toHaveBeenCalledTimes(1);
			// random(0, min(100, 2 ** 1)) = 1 ms
			expect(performance.now() - started).toBeLessThan(100);
		});
	});

	describe('the deprecated positional form', () => {
		beforeEach(() => resetPositionalAppendWarning());
		afterEach(() => resetPositionalAppendWarning());

		it('expects the stream at the aggregate version minus the number of events', async () => {
			const { store } = createStubStore();
			const stream = newStream();
			store.head = 3;

			const envelopes = await store.appendEvents(stream, 5, events.slice(0, 2), 'tenant');

			expect(versionsOf(envelopes)).toEqual([4, 5]);
			expect(store.persisted[0][1]).toEqual({
				stream,
				collection: 'tenant-events',
				expectedVersion: 3,
				pool: 'tenant',
			});
		});

		it('emits a DeprecationWarning once per process', async () => {
			const { store } = createStubStore();
			const emitWarning = process.emitWarning as unknown as MockInstance;

			await store.appendEvents(newStream(), 1, events.slice(0, 1));
			await store.appendEvents(newStream(), 1, events.slice(0, 1));
			await store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 });

			expect(emitWarning).toHaveBeenCalledTimes(1);
			expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('deprecated'), {
				type: 'DeprecationWarning',
				code: 'OCODA_ES_POSITIONAL_APPEND',
			});
		});
	});
});

describe('EventStore.getEvent and getEvents', () => {
	it('deserialize the envelopes the store reads', async () => {
		const { store } = createStubStore();
		const stream = newStream();
		await store.appendEvents(stream, events.slice(0, 3), { expectedVersion: 0 });

		await expect(store.getEvent(stream, 2)).resolves.toEqual(events[1]);
		const read: unknown[] = [];
		for await (const batch of store.getEvents(stream, { batch: 2 })) {
			read.push(batch);
		}
		expect(read).toEqual([events.slice(0, 2), events.slice(2, 3)]);
	});

	it('let the errors of the store through', async () => {
		const { store } = createStubStore();

		await expect(store.getEvent(newStream(), 1)).rejects.toBeInstanceOf(EventNotFoundException);
	});

	it('stop reading the envelopes when the consumer stops', async () => {
		const { store } = createStubStore();
		const stream = newStream();
		await store.appendEvents(stream, events.slice(0, 3), { expectedVersion: 0 });
		let released = false;
		vi.spyOn(store, 'getEnvelopes').mockImplementation(async function* () {
			try {
				yield [...store.stored];
				yield [...store.stored];
			} finally {
				released = true;
			}
		});

		for await (const _batch of store.getEvents(stream)) {
			break;
		}

		expect(released).toBe(true);
	});
});
