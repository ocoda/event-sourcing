import {
	EventCollection,
	EventEnvelope,
	EventId,
	type EventMap,
	EventNotFoundException,
	EventSourcingErrorCode,
	type EventStore,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	type EventStream,
	type IAllEventsFilter,
	type IEvent,
	type IEventFilter,
	StreamReadingDirection,
	UnregisteredEventException,
} from '@ocoda/event-sourcing';
import {
	CALL_TIMEOUT,
	ConformancePayloadProbed,
	ConformanceRecorded,
	LEAK_PROBE_ITERATIONS,
	TEST_TIMEOUT,
	UNREGISTERED_EVENT_NAME,
	call,
	collectBatches,
	conformanceTest,
	createConformanceEventMap,
	createDatePayloadProbe,
	createJsonPayloadProbe,
	drain,
	expectRejection,
	expectRejectionOfClass,
	newEventStream,
	recordedEvents,
	uniquePoolName,
	withinTimeout,
} from './fixtures.js';
import type { ConformanceStoreHandle } from './types.js';

/**
 * An event store with the optional envelope methods, which every store in this repository implements.
 */
export type ConformanceEventStore = EventStore<unknown> &
	Required<Pick<EventStore<unknown>, 'getEnvelope' | 'getEnvelopes'>>;

/**
 * Creates a connected event store for the given event map.
 */
export type EventStoreConformanceFactory = (
	eventMap: EventMap,
) => ConformanceStoreHandle<ConformanceEventStore> | Promise<ConformanceStoreHandle<ConformanceEventStore>>;

export const EVENT_STORE_CONFORMANCE_CASES = [
	'append-returns-envelopes',
	'append-sizes',
	'append-continues-stream',
	'read-round-trip',
	'envelope-metadata-round-trip',
	'occurred-on-milliseconds',
	'filter-from-version',
	'filter-backward',
	'filter-backward-from-version',
	'filter-limit',
	'filter-batch',
	'filter-empty-results',
	'conflict-stale-version',
	'conflict-overlapping-versions',
	'conflict-concurrent-appends',
	'not-found',
	'unknown-pool-append',
	'unknown-pool-read',
	'ensure-collection-idempotent',
	'list-collections',
	'all-envelopes-order',
	'all-envelopes-month-range',
	'all-envelopes-batch',
	'all-envelopes-full-batches',
	'early-break',
	'consumer-throws',
	'store-throws-mid-stream',
	'nested-calls-during-iteration',
	'payload-json-fidelity',
	'payload-dates-as-iso-strings',
] as const;

export type EventStoreConformanceCase = (typeof EVENT_STORE_CONFORMANCE_CASES)[number];

export interface EventStoreConformanceOptions {
	/**
	 * The base name of the pools the suite creates. Defaults to a name that is unique to this run.
	 */
	pool?: string;
	/**
	 * Cases the store doesn't satisfy (yet), with the reason. They are reported as skipped.
	 */
	skip?: Partial<Record<EventStoreConformanceCase, string>>;
	/**
	 * The timeout of a single test, in milliseconds.
	 */
	timeout?: number;
}

/**
 * The number of writers that race each other in the concurrency tests.
 */
const CONCURRENT_WRITERS = 8;

const range = (from: number, to: number): number[] =>
	from <= to
		? Array.from({ length: to - from + 1 }, (_, index) => from + index)
		: Array.from({ length: from - to + 1 }, (_, index) => from - index);

const seqOf = (event: IEvent): number => (event as ConformanceRecorded).seq;

/**
 * The parts of an envelope that must survive a round trip through the store.
 */
const describeEnvelope = ({ event, payload, metadata }: EventEnvelope) => ({
	event,
	payload,
	eventId: metadata.eventId.value,
	aggregateId: metadata.aggregateId,
	version: metadata.version,
	correlationId: metadata.correlationId,
	causationId: metadata.causationId,
});

/**
 * Events of three streams, spread over the months of 2021 and appended out of chronological order.
 */
const createMonthlyEnvelopes = (eventMap: EventMap) => {
	const layout = [
		['2021-01-15T08:00:00.000Z', '2021-03-02T12:00:00.000Z', '2021-05-20T18:30:00.000Z'],
		['2021-01-20T00:00:00.000Z', '2021-02-10T09:15:00.000Z', '2021-05-01T00:00:00.000Z'],
		// Straddles the boundary between January and February (UTC)
		['2021-01-31T23:59:59.999Z', '2021-02-01T00:00:00.000Z'],
	];

	const streams = layout.map((dates) => {
		const stream = newEventStream();
		const envelopes = dates.map((date, index) => {
			const event = new ConformanceRecorded(index + 1, 'monthly');
			return EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
				aggregateId: stream.aggregateId,
				version: index + 1,
				eventId: EventId.generate(new Date(date)),
			});
		});
		return { stream, envelopes };
	});

	const chronological = streams
		.flatMap(({ envelopes }) => envelopes)
		.sort((a, b) => a.metadata.occurredOn.getTime() - b.metadata.occurredOn.getTime());

	const inMonths = (...yearMonths: string[]) =>
		chronological.filter(({ metadata }) => yearMonths.includes(metadata.occurredOn.toISOString().substring(0, 7)));

	return { streams, chronological, inMonths };
};

/**
 * Registers the event store conformance suite: the contract that every event store has to satisfy,
 * independent of the database behind it.
 *
 * The suite creates its own pools (named after `options.pool`, unique by default) and hands their collections to
 * `cleanup` once it is done. It sets a no-op publish function on the store.
 */
export const describeEventStoreConformance = (
	name: string,
	factory: EventStoreConformanceFactory,
	options: EventStoreConformanceOptions = {},
): void => {
	const timeout = options.timeout ?? TEST_TIMEOUT;
	const test = conformanceTest<EventStoreConformanceCase>(options.skip, timeout);

	describe(`${name} event store conformance`, () => {
		const eventMap = createConformanceEventMap();

		const pool = options.pool ?? uniquePoolName();
		const allPool = `${pool}-all`;
		const unknownPool = `${pool}-unknown`;
		const collection = EventCollection.get(pool);
		const allCollection = EventCollection.get(allPool);

		let handle: ConformanceStoreHandle<ConformanceEventStore> | undefined;
		let store: ConformanceEventStore;

		// A stream of 7 events (versions 1 to 7, 'seq' equals the version), written in two appends
		const reference = newEventStream();
		const referenceEvents = recordedEvents(7);
		let referenceEnvelopes: EventEnvelope[] = [];

		// The only events in the 'all' pool, which getAllEnvelopes() reads
		const monthly = createMonthlyEnvelopes(eventMap);

		const readEvents = (stream: EventStream, filter: Omit<IEventFilter, 'pool'> = {}) =>
			store.getEvents(stream, { ...filter, pool });
		const readEnvelopes = (stream: EventStream, filter: Omit<IEventFilter, 'pool'> = {}) =>
			store.getEnvelopes(stream, { ...filter, pool });
		const readAllEnvelopes = (filter: Omit<IAllEventsFilter, 'pool'>) =>
			store.getAllEnvelopes({ ...filter, pool: allPool });

		const envelopeFor = (stream: EventStream, event: IEvent, version: number, eventId?: EventId) =>
			EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
				aggregateId: stream.aggregateId,
				version,
				eventId,
			});

		/**
		 * Asserts the versions that getEvents() and getEnvelopes() read from the reference stream, per batch.
		 */
		const expectBatches = async (filter: Omit<IEventFilter, 'pool'>, expected: number[][]) => {
			const eventBatches = await collectBatches(readEvents(reference, filter));
			const envelopeBatches = await collectBatches(readEnvelopes(reference, filter));

			expect(
				eventBatches.map((batch) => batch.map(seqOf)),
				`getEvents(${JSON.stringify(filter)})`,
			).toEqual(expected);
			expect(
				envelopeBatches.map((batch) => batch.map(({ metadata }) => metadata.version)),
				`getEnvelopes(${JSON.stringify(filter)})`,
			).toEqual(expected);
		};

		/**
		 * Asserts the versions that getEvents() and getEnvelopes() read from the reference stream.
		 */
		const expectVersions = async (filter: Omit<IEventFilter, 'pool'>, expected: number[]) => {
			const events = await drain(readEvents(reference, filter));
			const envelopes = await drain(readEnvelopes(reference, filter));

			expect(events.map(seqOf), `getEvents(${JSON.stringify(filter)})`).toEqual(expected);
			expect(
				envelopes.map(({ metadata }) => metadata.version),
				`getEnvelopes(${JSON.stringify(filter)})`,
			).toEqual(expected);
		};

		/**
		 * Asserts that the store still serves reads and writes, within a timeout.
		 */
		const expectStoreToBeUsable = (context: string) =>
			withinTimeout(
				(async () => {
					await expect(call(() => store.getEvent(reference, 7, pool))).resolves.toEqual(referenceEvents[6]);
					expect((await drain(readEvents(reference))).map(seqOf)).toEqual(range(1, 7));
					await expect(store.appendEvents(newEventStream(), 1, recordedEvents(1), pool)).resolves.toHaveLength(1);
				})(),
				`Store calls ${context}`,
			);

		const readers: [string, () => AsyncGenerator<unknown[]>][] = [
			['getEvents', () => readEvents(reference, { batch: 1 })],
			['getEnvelopes', () => readEnvelopes(reference, { batch: 1 })],
			['getAllEnvelopes', () => readAllEnvelopes({ since: { year: 2021, month: 1 }, batch: 1 })],
			['listCollections', () => store.listCollections({ batch: 1 })],
		];

		beforeAll(async () => {
			handle = await factory(eventMap);
			store = handle.store;
			store.publish = async () => undefined;

			await store.ensureCollection(pool);
			await store.ensureCollection(allPool);

			referenceEnvelopes = [
				...(await store.appendEvents(reference, 4, referenceEvents.slice(0, 4), pool)),
				...(await store.appendEvents(reference, 7, referenceEvents.slice(4), pool)),
			];

			for (const { stream, envelopes } of monthly.streams) {
				await store.appendEvents(stream, envelopes.length, envelopes, allPool);
			}
		}, timeout);

		afterAll(async () => {
			await handle?.cleanup([collection, allCollection, EventCollection.get(unknownPool)]);
		}, timeout);

		describe('appending', () => {
			test('append-returns-envelopes', 'returns an envelope per appended event', async () => {
				const stream = newEventStream();
				const events = recordedEvents(3);

				const envelopes = await store.appendEvents(stream, 3, events, pool);

				expect(envelopes).toHaveLength(3);
				for (const [index, envelope] of envelopes.entries()) {
					expect(envelope).toBeInstanceOf(EventEnvelope);
					expect(envelope.event).toBe('conformance-recorded');
					expect(envelope.payload).toEqual(eventMap.serializeEvent(events[index]));
					expect(envelope.metadata.aggregateId).toBe(stream.aggregateId);
					expect(envelope.metadata.version).toBe(index + 1);
					expect(envelope.metadata.occurredOn).toEqual(envelope.metadata.eventId.date);
				}

				// Event ids are unique and ordered like the events
				const eventIds = envelopes.map(({ metadata }) => metadata.eventId.value);
				expect([...eventIds].sort()).toEqual(eventIds);
				expect(new Set(eventIds).size).toBe(3);
			});

			for (const count of [1, 25, 26]) {
				test('append-sizes', `appends ${count} event(s) at once`, async () => {
					const stream = newEventStream();

					const envelopes = await store.appendEvents(stream, count, recordedEvents(count), pool);

					expect(envelopes.map(({ metadata }) => metadata.version)).toEqual(range(1, count));
					expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, count));
					expect((await drain(readEnvelopes(stream))).map(({ metadata }) => metadata.version)).toEqual(range(1, count));
					await expect(call(() => store.getEvent(stream, count, pool))).resolves.toEqual(
						new ConformanceRecorded(count),
					);
				});
			}

			test('append-continues-stream', 'continues a stream where the previous append ended', async () => {
				expect(referenceEnvelopes.map(({ metadata }) => metadata.version)).toEqual(range(1, 7));
				expect((await drain(readEnvelopes(reference))).map(describeEnvelope)).toEqual(
					referenceEnvelopes.map(describeEnvelope),
				);
			});
		});

		describe('reading', () => {
			test('read-round-trip', 'reads back what was appended, in version order', async () => {
				const stream = newEventStream();
				const events = recordedEvents(3);
				const appended = await store.appendEvents(stream, 3, events, pool);

				const read = await drain(readEvents(stream));
				expect(read).toEqual(events);
				for (const event of read) {
					expect(event).toBeInstanceOf(ConformanceRecorded);
				}

				const envelopes = await drain(readEnvelopes(stream));
				expect(envelopes.map(describeEnvelope)).toEqual(appended.map(describeEnvelope));

				for (const [index, envelope] of appended.entries()) {
					const version = index + 1;

					const event = await call(() => store.getEvent(stream, version, pool));
					expect(event).toBeInstanceOf(ConformanceRecorded);
					expect(event).toEqual(events[index]);

					const single = await call(() => store.getEnvelope(stream, version, pool));
					expect(describeEnvelope(single)).toEqual(describeEnvelope(envelope));
					expect(single.metadata.occurredOn).toBeInstanceOf(Date);
					expect(Math.abs(single.metadata.occurredOn.getTime() - envelope.metadata.occurredOn.getTime())).toBeLessThan(
						1_000,
					);
				}
			});

			test(
				'envelope-metadata-round-trip',
				'keeps the event id, correlation id and causation id of appended envelopes',
				async () => {
					const stream = newEventStream();
					const nextEventId = EventId.factory();
					const envelopes = recordedEvents(3).map((event, index) =>
						EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
							aggregateId: stream.aggregateId,
							version: index + 1,
							eventId: nextEventId(new Date('2020-06-10T10:00:00.000Z')),
							correlationId: `correlation-${stream.aggregateId}`,
							causationId: `causation-${index}`,
						}),
					);

					await store.appendEvents(stream, 3, envelopes, pool);

					const expected = envelopes.map(describeEnvelope);
					expect((await drain(readEnvelopes(stream))).map(describeEnvelope)).toEqual(expected);
					for (const [index, envelope] of expected.entries()) {
						expect(describeEnvelope(await call(() => store.getEnvelope(stream, index + 1, pool)))).toEqual(envelope);
					}

					const allEnvelopes = await drain(
						store.getAllEnvelopes({ pool, since: { year: 2020, month: 6 }, until: { year: 2020, month: 6 } }),
					);
					expect(
						allEnvelopes.filter(({ metadata }) => metadata.aggregateId === stream.aggregateId).map(describeEnvelope),
					).toEqual(expected);
				},
			);

			test('occurred-on-milliseconds', 'keeps occurredOn to the millisecond', async () => {
				const stream = newEventStream();
				const occurredOn = new Date('2024-06-15T10:20:30.123Z');
				const envelope = envelopeFor(stream, new ConformanceRecorded(1), 1, EventId.generate(occurredOn));

				await store.appendEvents(stream, 1, [envelope], pool);

				const single = await call(() => store.getEnvelope(stream, 1, pool));
				const [fromStream] = await drain(readEnvelopes(stream));
				expect(single.metadata.occurredOn.toISOString()).toBe(occurredOn.toISOString());
				expect(fromStream.metadata.occurredOn.toISOString()).toBe(occurredOn.toISOString());
			});

			test('not-found', 'throws an EventNotFoundException for a version or stream that has no event', async () => {
				await expectRejectionOfClass(
					call(() => store.getEvent(reference, 8, pool)),
					EventNotFoundException,
				);
				await expectRejectionOfClass(
					call(() => store.getEvent(newEventStream(), 1, pool)),
					EventNotFoundException,
				);
				await expectRejectionOfClass(
					call(() => store.getEnvelope(reference, 8, pool)),
					EventNotFoundException,
				);
				await expectRejectionOfClass(
					call(() => store.getEnvelope(newEventStream(), 1, pool)),
					EventNotFoundException,
				);
			});
		});

		describe('read filters', () => {
			test('filter-from-version', 'reads from fromVersion on', async () => {
				await expectVersions({ fromVersion: 1 }, range(1, 7));
				await expectVersions({ fromVersion: 3 }, range(3, 7));
				await expectVersions({ fromVersion: 7 }, [7]);
			});

			test('filter-backward', 'reads backward', async () => {
				await expectVersions({ direction: StreamReadingDirection.BACKWARD }, range(7, 1));
				await expectVersions({ direction: StreamReadingDirection.FORWARD }, range(1, 7));
			});

			test('filter-backward-from-version', 'reads backward down to fromVersion', async () => {
				await expectVersions({ direction: StreamReadingDirection.BACKWARD, fromVersion: 3 }, range(7, 3));
				await expectVersions({ direction: StreamReadingDirection.BACKWARD, fromVersion: 7 }, [7]);
			});

			test('filter-limit', 'reads at most limit events', async () => {
				await expectVersions({ limit: 1 }, [1]);
				await expectVersions({ limit: 3 }, range(1, 3));
				await expectVersions({ limit: 10 }, range(1, 7));
				await expectVersions({ limit: 3, direction: StreamReadingDirection.BACKWARD }, range(7, 5));
				await expectVersions({ limit: 3, fromVersion: 2 }, range(2, 4));
				await expectVersions({ limit: 2, fromVersion: 3, direction: StreamReadingDirection.BACKWARD }, [7, 6]);
			});

			test('filter-batch', 'hands out full batches of batch events, and never changes them afterwards', async () => {
				await expectBatches(
					{ batch: 1 },
					range(1, 7).map((version) => [version]),
				);
				await expectBatches({ batch: 3 }, [range(1, 3), range(4, 6), [7]]);
				await expectBatches({ batch: 7 }, [range(1, 7)]);
				await expectBatches({ batch: 10 }, [range(1, 7)]);
				await expectBatches({ batch: 2, limit: 5 }, [range(1, 2), range(3, 4), [5]]);
				await expectBatches({ batch: 2, fromVersion: 4 }, [range(4, 5), range(6, 7)]);
				await expectBatches({ batch: 3, direction: StreamReadingDirection.BACKWARD }, [range(7, 5), range(4, 2), [1]]);
				await expectBatches({}, [range(1, 7)]);
			});

			test('filter-empty-results', 'yields no batch at all when nothing matches', async () => {
				expect(await collectBatches(readEvents(newEventStream()))).toEqual([]);
				expect(await collectBatches(readEnvelopes(newEventStream()))).toEqual([]);
				expect(await collectBatches(readEvents(reference, { fromVersion: 8 }))).toEqual([]);
				expect(await collectBatches(readEnvelopes(reference, { fromVersion: 8 }))).toEqual([]);
			});
		});

		describe('optimistic concurrency', () => {
			test(
				'conflict-stale-version',
				'rejects an append at or below the current version with an EventStoreVersionConflictException',
				async () => {
					const stream = newEventStream();
					await store.appendEvents(stream, 3, recordedEvents(3), pool);

					for (const version of [3, 2, 1]) {
						await expectRejectionOfClass(
							store.appendEvents(stream, version, [new ConformanceRecorded(99)], pool),
							EventStoreVersionConflictException,
							{
								code: EventSourcingErrorCode.EventStoreVersionConflict,
								streamId: stream.streamId,
								aggregateId: stream.aggregateId,
								pool,
								expectedVersion: version - 1,
								actualVersion: 3,
							},
						);
					}
					await expectRejectionOfClass(
						store.appendEvents(stream, 3, recordedEvents(2, 98), pool),
						EventStoreVersionConflictException,
						{ expectedVersion: 1, actualVersion: 3 },
					);

					// Nothing was written
					expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, 3));

					// The next version is still accepted
					await expect(store.appendEvents(stream, 4, recordedEvents(1, 4), pool)).resolves.toHaveLength(1);
				},
			);

			test(
				'conflict-overlapping-versions',
				'rejects an append whose first version is already taken with an EventStoreVersionConflictException',
				async () => {
					const stream = newEventStream();
					await store.appendEvents(stream, 3, recordedEvents(3), pool);

					// Versions 3 and 4, of which 3 exists
					await expectRejectionOfClass(
						store.appendEvents(stream, 4, recordedEvents(2, 3, 'overlap'), pool),
						EventStoreVersionConflictException,
					);

					const events = (await drain(readEvents(stream))) as ConformanceRecorded[];
					expect(events.map(seqOf)).toEqual(range(1, 3));
					expect(events.map(({ writer }) => writer)).not.toContain('overlap');
				},
			);

			for (const seeded of [0, 2]) {
				test(
					'conflict-concurrent-appends',
					`lets exactly one of ${CONCURRENT_WRITERS} concurrent appends to ${seeded ? 'an existing' : 'a new'} stream win`,
					async () => {
						const stream = newEventStream();
						if (seeded) {
							await store.appendEvents(stream, seeded, recordedEvents(seeded), pool);
						}
						const target = seeded + 2;

						const results = await withinTimeout(
							Promise.allSettled(
								Array.from({ length: CONCURRENT_WRITERS }, (_, writer) =>
									store.appendEvents(stream, target, recordedEvents(2, seeded + 1, `writer-${writer}`), pool),
								),
							),
							'Concurrent appends',
						);

						const winners = results.flatMap((result, writer) => (result.status === 'fulfilled' ? [writer] : []));
						expect(winners, 'the number of appends that succeeded').toHaveLength(1);
						// Every other append lost the race with a version conflict
						const otherFailures = results.flatMap((result) =>
							result.status === 'rejected' && result.reason?.constructor !== EventStoreVersionConflictException
								? [String(result.reason)]
								: [],
						);
						expect(otherFailures).toEqual([]);

						const events = (await drain(readEvents(stream))) as ConformanceRecorded[];
						expect(events.map(seqOf)).toEqual(range(1, target));
						expect(events.slice(seeded).map(({ writer }) => writer)).toEqual([
							`writer-${winners[0]}`,
							`writer-${winners[0]}`,
						]);
					},
				);
			}
		});

		describe('pools', () => {
			test(
				'unknown-pool-append',
				'rejects an append to a pool whose collection was never created, without creating it',
				async () => {
					await expectRejectionOfClass(
						store.appendEvents(newEventStream(), 1, recordedEvents(1), unknownPool),
						EventStorePersistenceException,
						{ code: EventSourcingErrorCode.EventStorePersistence, outcome: 'not-persisted' },
					);
					expect(await drain(store.listCollections())).not.toContain(EventCollection.get(unknownPool));
				},
			);

			test('unknown-pool-read', 'rejects reads from a pool whose collection was never created', async () => {
				const filter = { pool: unknownPool };
				await expectRejection(drain(store.getEvents(reference, filter)), 'getEvents()');
				await expectRejection(drain(store.getEnvelopes(reference, filter)), 'getEnvelopes()');
				await expectRejection(
					call(() => store.getEvent(reference, 1, unknownPool)),
					'getEvent()',
				);
				await expectRejection(
					call(() => store.getEnvelope(reference, 1, unknownPool)),
					'getEnvelope()',
				);
				await expectRejection(
					drain(store.getAllEnvelopes({ ...filter, since: { year: 2021, month: 1 }, until: { year: 2021, month: 2 } })),
					'getAllEnvelopes()',
				);
			});

			test('ensure-collection-idempotent', 'ensures an existing collection without touching its events', async () => {
				await expect(call(() => store.ensureCollection(pool))).resolves.toBe(collection);
				await expect(call(() => store.ensureCollection(pool))).resolves.toBe(collection);

				expect((await drain(readEnvelopes(reference))).map(describeEnvelope)).toEqual(
					referenceEnvelopes.map(describeEnvelope),
				);

				const stream = newEventStream();
				await expect(store.appendEvents(stream, 2, recordedEvents(2), pool)).resolves.toHaveLength(2);
				expect((await drain(readEvents(stream))).map(seqOf)).toEqual([1, 2]);
			});

			test('list-collections', 'lists the collections of the pools, in batches of at most batch', async () => {
				const batches = await collectBatches(store.listCollections({ batch: 1 }));
				for (const batch of batches) {
					expect(batch).toHaveLength(1);
				}

				const collections = batches.flat();
				expect(collections).toContain(collection);
				expect(collections).toContain(allCollection);
				expect(new Set(collections).size).toBe(collections.length);

				expect(await drain(store.listCollections())).toEqual(expect.arrayContaining([collection, allCollection]));
			});
		});

		describe('getAllEnvelopes', () => {
			test('all-envelopes-order', 'reads the envelopes of every stream in the order they occurred', async () => {
				const expected = monthly.chronological.map(describeEnvelope);

				const read = await drain(
					readAllEnvelopes({ since: { year: 2021, month: 1 }, until: { year: 2021, month: 5 } }),
				);
				expect(read.map(describeEnvelope)).toEqual(expected);

				// Without an end, up to the current month
				expect((await drain(readAllEnvelopes({ since: { year: 2021, month: 1 } }))).map(describeEnvelope)).toEqual(
					expected,
				);
			});

			test('all-envelopes-month-range', 'reads only the envelopes of the months from since to until', async () => {
				const ranges: [IAllEventsFilter['since'], IAllEventsFilter['until'], EventEnvelope[]][] = [
					[{ year: 2021, month: 1 }, { year: 2021, month: 1 }, monthly.inMonths('2021-01')],
					[{ year: 2021, month: 2 }, { year: 2021, month: 3 }, monthly.inMonths('2021-02', '2021-03')],
					[{ year: 2020, month: 12 }, { year: 2021, month: 2 }, monthly.inMonths('2021-01', '2021-02')],
					[{ year: 2021, month: 4 }, { year: 2021, month: 4 }, []],
					[{ year: 2021, month: 6 }, { year: 2021, month: 12 }, []],
				];

				for (const [since, until, expected] of ranges) {
					expect(
						(await drain(readAllEnvelopes({ since, until }))).map(describeEnvelope),
						`${JSON.stringify(since)} - ${JSON.stringify(until)}`,
					).toEqual(expected.map(describeEnvelope));
				}
			});

			test('all-envelopes-batch', 'hands out batches of at most batch envelopes', async () => {
				const batches = await collectBatches(
					readAllEnvelopes({ since: { year: 2021, month: 1 }, until: { year: 2021, month: 5 }, batch: 2 }),
				);

				for (const batch of batches) {
					expect(batch.length).toBeGreaterThan(0);
					expect(batch.length).toBeLessThanOrEqual(2);
				}
				expect(batches.flat().map(describeEnvelope)).toEqual(monthly.chronological.map(describeEnvelope));
			});

			test('all-envelopes-full-batches', 'fills every batch but the last', async () => {
				const batches = await collectBatches(
					readAllEnvelopes({ since: { year: 2021, month: 1 }, until: { year: 2021, month: 5 }, batch: 3 }),
				);

				expect(batches.map((batch) => batch.length)).toEqual([3, 3, 2]);
			});
		});

		describe('iteration', () => {
			test(
				'early-break',
				'stays usable when a consumer stops reading early',
				async () => {
					for (const [method, read] of readers) {
						for (let iteration = 0; iteration < LEAK_PROBE_ITERATIONS; iteration++) {
							await withinTimeout(
								(async () => {
									for await (const batch of read()) {
										expect(batch.length).toBeGreaterThan(0);
										break;
									}
								})(),
								`Breaking out of ${method}()`,
							);
						}
						await expectStoreToBeUsable(`after breaking out of ${method}()`);
					}
				},
				timeout * 2,
			);

			test(
				'consumer-throws',
				'stays usable when a consumer throws while reading',
				async () => {
					for (const [method, read] of readers) {
						for (let iteration = 0; iteration < LEAK_PROBE_ITERATIONS; iteration++) {
							const failure = new Error(`Consumer of ${method}() failed`);
							const consume = async () => {
								for await (const _batch of read()) {
									throw failure;
								}
							};
							await expect(withinTimeout(consume(), `Throwing out of ${method}()`)).rejects.toBe(failure);
						}
						await expectStoreToBeUsable(`after throwing out of ${method}()`);
					}
				},
				timeout * 2,
			);

			test(
				'store-throws-mid-stream',
				'surfaces an event it can not deserialize and stays usable',
				async () => {
					const stream = newEventStream();
					const nextEventId = EventId.factory();
					await store.appendEvents(
						stream,
						3,
						[
							envelopeFor(stream, new ConformanceRecorded(1), 1, nextEventId()),
							EventEnvelope.create(
								UNREGISTERED_EVENT_NAME,
								{ unknown: true },
								{
									aggregateId: stream.aggregateId,
									version: 2,
									eventId: nextEventId(),
								},
							),
							envelopeFor(stream, new ConformanceRecorded(3), 3, nextEventId()),
						],
						pool,
					);

					for (let iteration = 0; iteration < LEAK_PROBE_ITERATIONS; iteration++) {
						await expectRejectionOfClass(
							withinTimeout(drain(readEvents(stream, { batch: 1 })), 'Reading an unregistered event'),
							UnregisteredEventException,
						);
					}
					await expectRejectionOfClass(
						call(() => store.getEvent(stream, 2, pool)),
						UnregisteredEventException,
					);

					// Envelopes aren't deserialized
					expect((await drain(readEnvelopes(stream))).map(({ event }) => event)).toEqual([
						'conformance-recorded',
						UNREGISTERED_EVENT_NAME,
						'conformance-recorded',
					]);

					await expectStoreToBeUsable('after a read failed');
				},
				timeout * 2,
			);

			test('nested-calls-during-iteration', 'serves other calls while a read is in progress', async () => {
				const stream = newEventStream();
				const versions: number[] = [];

				await withinTimeout(
					(async () => {
						for await (const batch of readEvents(reference, { batch: 1 })) {
							versions.push(...batch.map(seqOf));

							await expect(call(() => store.getEvent(reference, 1, pool))).resolves.toEqual(referenceEvents[0]);
							expect((await drain(readEnvelopes(reference, { fromVersion: 7 }))).map(describeEnvelope)).toEqual([
								describeEnvelope(referenceEnvelopes[6]),
							]);
							await store.appendEvents(stream, versions.length, recordedEvents(1, versions.length), pool);
						}
					})(),
					'Store calls made while reading',
					CALL_TIMEOUT * 2,
				);

				expect(versions).toEqual(range(1, 7));
				expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, 7));
			});
		});

		describe('payloads', () => {
			test('payload-json-fidelity', 'returns JSON payloads exactly as they were appended', async () => {
				const stream = newEventStream();
				const data = createJsonPayloadProbe();

				await store.appendEvents(stream, 1, [new ConformancePayloadProbed(data)], pool);

				const event = await call(() => store.getEvent(stream, 1, pool));
				expect(event).toBeInstanceOf(ConformancePayloadProbed);
				expect((event as ConformancePayloadProbed).data).toStrictEqual(data);

				const [fromStream] = await drain(readEvents(stream));
				expect(fromStream).toBeInstanceOf(ConformancePayloadProbed);
				expect((fromStream as ConformancePayloadProbed).data).toStrictEqual(data);

				expect((await call(() => store.getEnvelope(stream, 1, pool))).payload).toStrictEqual({ data });
				expect((await drain(readEnvelopes(stream)))[0].payload).toStrictEqual({ data });
			});

			test('payload-dates-as-iso-strings', 'returns dates in payloads as ISO-8601 strings', async () => {
				const stream = newEventStream();
				const { payload, expected } = createDatePayloadProbe();

				await store.appendEvents(stream, 1, [new ConformancePayloadProbed(payload)], pool);

				expect((await call(() => store.getEnvelope(stream, 1, pool))).payload).toStrictEqual({ data: expected });
				expect((await drain(readEnvelopes(stream)))[0].payload).toStrictEqual({ data: expected });
				expect(((await call(() => store.getEvent(stream, 1, pool))) as ConformancePayloadProbed).data).toStrictEqual(
					expected,
				);
			});
		});
	});
};
