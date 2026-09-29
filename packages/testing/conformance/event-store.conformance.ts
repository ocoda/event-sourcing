import {
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventSourcingErrorCode,
	EventStore,
	type EventStoreCapabilities,
	type EventStoreContext,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	type EventStream,
	ExpectedVersion,
	type IEvent,
	type IEventFilter,
	type IEventPool,
	InvalidAppendOptionsException,
	StreamReadingDirection,
	UnregisteredEventException,
	UnsupportedOperationException,
	assertEventStoreImplementation,
	isEventSourcingError,
	resolveCapabilities,
} from '@ocoda/event-sourcing';
import type { MockInstance } from 'vitest';
import {
	CALL_TIMEOUT,
	type ConformanceTestContext,
	ConformancePayloadProbed,
	ConformanceRecorded,
	HEAVY_TEST_TIMEOUT,
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
	expectRejectionOfClass,
	newEventStream,
	recordedEvents,
	rejectionOf,
	stringify,
	uniquePoolName,
	withinTimeout,
} from './fixtures.js';
import { RecordingPublisher } from './recording-publisher.js';
import type { EventStoreConformanceHandle } from './types.js';

/**
 * The event store the conformance suite tests.
 */
export type ConformanceEventStore = EventStore<unknown>;

/**
 * Creates a connected event store with the given context (the conformance event map and a recording publisher).
 */
export type EventStoreConformanceFactory = (
	context: EventStoreContext,
) => EventStoreConformanceHandle<ConformanceEventStore> | Promise<EventStoreConformanceHandle<ConformanceEventStore>>;

export const EVENT_STORE_CONFORMANCE_CASES = [
	'append-returns-envelopes',
	'append-sizes',
	'append-continues-stream',
	'append-empty-noop',
	'append-envelope-contiguity',
	'append-envelope-preserved',
	'append-deprecated-positional',
	'append-atomic-partial-failure',
	'expected-exact',
	'expected-stale',
	'expected-gap',
	'no-stream-on-existing',
	'expected-invalid',
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
	'conflict-fields',
	'concurrent-any',
	'not-found',
	'unknown-pool-append',
	'unknown-pool-read',
	'ensure-collection-idempotent',
	'list-collections',
	'template-not-overridden',
	'publish-committed-once',
	'publish-false-skips-publisher',
	'conflict-publishes-nothing',
	'publisher-failure-does-not-reject',
	'metadata-round-trip',
	'headers-round-trip',
	'headers-unsupported-rejects',
	'metadata-validation-no-io',
	'read-all-order',
	'read-all-positions-on-reads',
	'read-all-resume',
	'read-all-gap-safe',
	'read-all-best-effort',
	'early-break',
	'consumer-throws',
	'read-all-early-break',
	'read-all-consumer-throws',
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
	/**
	 * Registers only these cases.
	 */
	only?: readonly EventStoreConformanceCase[];
	/**
	 * Registers every case as a test that passes only when the case fails: for negative controls, deliberately broken
	 * stores that prove the cases detect what they check. Pass a pattern per case to require the failure message to
	 * match it, so that a case that fails for another reason than the defect doesn't count. A case that the store's
	 * capabilities gate off fails.
	 */
	expectFailure?: boolean | Partial<Record<EventStoreConformanceCase, RegExp>>;
}

/**
 * The number of writers that race each other in the concurrency tests.
 */
const CONCURRENT_WRITERS = 8;

/**
 * The number of appends of every writer of `read-all-gap-safe`.
 */
const GAP_SAFE_APPENDS_PER_WRITER = 25;

type Capabilities = Required<EventStoreCapabilities>;

/**
 * The methods of the store contract a store implements, which the no-I/O cases spy on.
 */
type SpiMethod = 'getStreamVersion' | 'persistEvents';

const range = (from: number, to: number): number[] =>
	from <= to
		? Array.from({ length: to - from + 1 }, (_, index) => from + index)
		: Array.from({ length: from - to + 1 }, (_, index) => from - index);

const seqOf = (event: IEvent): number => (event as ConformanceRecorded).seq;

const versionsOf = (envelopes: readonly EventEnvelope[]): number[] => envelopes.map(({ metadata }) => metadata.version);

const positionsOf = (envelopes: readonly EventEnvelope[]): (bigint | undefined)[] =>
	envelopes.map(({ metadata }) => metadata.globalPosition);

const idsOf = (envelopes: readonly EventEnvelope[]): string[] =>
	envelopes.map(({ metadata }) => metadata.eventId.value);

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
 * Everything an envelope carries once it is stored, including the v4 metadata.
 */
const describeStored = (envelope: EventEnvelope) => ({
	...describeEnvelope(envelope),
	occurredOn: envelope.metadata.occurredOn?.toISOString(),
	headers: envelope.metadata.headers,
	eventVersion: envelope.metadata.eventVersion,
	globalPosition: envelope.metadata.globalPosition,
});

/**
 * Asserts that the positions are bigints that strictly increase.
 */
const expectStrictlyIncreasing = (positions: readonly (bigint | undefined)[], description: string) => {
	for (const [index, position] of positions.entries()) {
		expect(typeof position, `${description}: the position at index ${index}`).toBe('bigint');
		if (index > 0) {
			expect(
				(position as bigint) > (positions[index - 1] as bigint),
				`${description}: position ${stringify(position)} follows ${stringify(positions[index - 1])}`,
			).toBe(true);
		}
	}
};

/**
 * Asserts that the positions of the envelopes of one append are consecutive bigints.
 */
const expectConsecutive = (envelopes: readonly EventEnvelope[], description: string) => {
	const positions = positionsOf(envelopes);
	expectStrictlyIncreasing(positions, description);
	if (positions.length > 0) {
		const first = positions[0] as bigint;
		expect(positions, `${description}: consecutive positions`).toEqual(
			positions.map((_, index) => first + BigInt(index)),
		);
	}
};

/**
 * Registers the event store conformance suite: the contract that every event store has to satisfy,
 * independent of the database behind it.
 *
 * The suite creates the store through `factory`, with a context that holds the conformance event map and a
 * `RecordingPublisher`. It creates its own pools (named after `options.pool`, unique by default) and hands their
 * collections to `cleanup` once it is done. Cases that need a capability the store doesn't claim are skipped with
 * `capability: <what is missing>`.
 */
/**
 * Waits for every promise, then fails with the first rejection, if any. Unlike `Promise.all`, no writer is still
 * appending when a case ends, so a failing case doesn't leave writes (or unhandled rejections) to the next one.
 */
const allSettledOrThrow = async <T>(promises: readonly Promise<T>[]): Promise<T[]> => {
	const results = await Promise.allSettled(promises);
	const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
	if (rejected) {
		throw rejected.reason;
	}
	return results.map((result) => (result as PromiseFulfilledResult<T>).value);
};

/**
 * Yields to the event loop, so that other tasks (a tailing reader) run even between appends that wait for no I/O.
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export const describeEventStoreConformance = (
	name: string,
	factory: EventStoreConformanceFactory,
	options: EventStoreConformanceOptions = {},
): void => {
	const timeout = options.timeout ?? TEST_TIMEOUT;
	const heavyTimeout = Math.max(timeout, HEAVY_TEST_TIMEOUT);
	let capabilities: Capabilities;
	const test = conformanceTest<EventStoreConformanceCase, Capabilities>(options.skip, timeout, () => capabilities, {
		only: options.only,
		expectFailure: options.expectFailure,
	});

	// A suite that registers only some cases doesn't group them, since a group without tests fails
	const group = options.only ? (_name: string, fn: () => void) => fn() : describe;

	describe(`${name} event store conformance`, () => {
		const eventMap = createConformanceEventMap();
		const publisher = new RecordingPublisher();
		const context: EventStoreContext = { eventMap, publisher };

		const pool = options.pool ?? uniquePoolName();
		const unknownPool = `${pool}-unknown`;
		const collection = EventCollection.get(pool);

		let handle: EventStoreConformanceHandle<ConformanceEventStore> | undefined;
		let store: ConformanceEventStore;

		// The pools some cases create for themselves, dropped at the end. Numbered, so that a repeated case
		// (CONFORMANCE_REPEAT) gets a fresh pool every time.
		const createdPools: IEventPool[] = [];
		const createPool = async (suffix: string): Promise<IEventPool> => {
			const created = `${pool}-${suffix}${createdPools.length + 1}`;
			createdPools.push(created);
			await store.ensureCollection(created);
			return created;
		};

		// A stream of 7 events (versions 1 to 7, 'seq' equals the version), written in two appends
		const reference = newEventStream();
		const referenceEvents = recordedEvents(7);
		let referenceEnvelopes: EventEnvelope[] = [];

		/**
		 * Whether the cases can read with readAll: the readAll parts of other cases are skipped along with read-all-order,
		 * for stores that can't read all yet. Also with `CONFORMANCE_RUN_SKIPPED`, which then shows exactly the skipped
		 * cases failing; read-all-order itself runs then.
		 */
		const readsAll = () => !options.skip?.['read-all-order'];

		/**
		 * Runs the readAll part of a case, or annotates the case with why it didn't.
		 */
		const readAllPart = async (context: ConformanceTestContext, fn: () => Promise<void>) => {
			if (readsAll()) {
				await fn();
			} else {
				await context.annotate('readAll part skipped: read-all-order is skipped for this store');
			}
		};

		const readEvents = (stream: EventStream, filter: Omit<IEventFilter, 'pool'> = {}) =>
			store.getEvents(stream, { ...filter, pool });
		const readEnvelopes = (stream: EventStream, filter: Omit<IEventFilter, 'pool'> = {}) =>
			store.getEnvelopes(stream, { ...filter, pool });
		const readAllOf = (readPool: IEventPool, fromPosition?: bigint, batch?: number) =>
			drain(store.readAll({ pool: readPool, fromPosition, batch }));
		const append = (
			stream: EventStream,
			events: readonly (IEvent | EventEnvelope)[],
			expectedVersion: ExpectedVersion,
			appendPool: IEventPool = pool,
		) => store.appendEvents(stream, events, { expectedVersion, pool: appendPool });

		const envelopeFor = (stream: EventStream, event: IEvent, version: number, eventId?: EventId) =>
			EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
				aggregateId: stream.aggregateId,
				version,
				eventId,
			});

		/**
		 * Spies on a method of the store contract where the store defines it (the store itself, or the first class of its
		 * prototype chain that does), so that the base class's calls (`this.persistEvents(...)`) go through the spy.
		 */
		const spyOnStore = (method: SpiMethod): MockInstance => {
			let owner: object | null = store;
			while (owner && !Object.hasOwn(owner, method)) {
				owner = Object.getPrototypeOf(owner);
			}
			return vi.spyOn(owner as Record<string, never>, method as never);
		};

		/**
		 * INTERIM(H): spies on the `appendEvents` of a store that overrides it (the interim legacy path), where its class
		 * defines it. The legacy wrapper calls it for every append that passed the checks, instead of the driver methods.
		 */
		const spyOnOverriddenAppend = (): MockInstance[] => {
			let owner: object | null = Object.getPrototypeOf(store);
			while (owner && owner !== EventStore.prototype) {
				if (Object.hasOwn(owner, 'appendEvents')) {
					return [vi.spyOn(owner as Record<string, never>, 'appendEvents' as never)];
				}
				owner = Object.getPrototypeOf(owner);
			}
			return [];
		};

		/**
		 * Runs `fn` and asserts that it called neither getStreamVersion nor persistEvents (nor the store's own
		 * appendEvents), nor the publisher.
		 */
		const expectNoIo = async (description: string, fn: () => Promise<void>) => {
			const spies = [spyOnStore('getStreamVersion'), spyOnStore('persistEvents'), ...spyOnOverriddenAppend()];
			const mark = publisher.mark();
			try {
				await fn();
				for (const spy of spies) {
					expect(spy, `${description}: ${spy.getMockName()}`).not.toHaveBeenCalled();
				}
				expect(publisher.callsSince(mark), `${description}: publishAll`).toEqual([]);
			} finally {
				for (const spy of spies) {
					spy.mockRestore();
				}
			}
		};

		/**
		 * The global position of the last event of a pool, 0n for an empty pool.
		 */
		const lastPositionOf = async (readPool: IEventPool): Promise<bigint> =>
			(await readAllOf(readPool)).at(-1)?.metadata.globalPosition ?? 0n;

		/**
		 * Asserts the versions that getEvents() and getEnvelopes() read from the reference stream, per batch.
		 */
		const expectBatches = async (filter: Omit<IEventFilter, 'pool'>, expected: number[][]) => {
			const eventBatches = await collectBatches(readEvents(reference, filter));
			const envelopeBatches = await collectBatches(readEnvelopes(reference, filter));

			expect(
				eventBatches.map((batch) => batch.map(seqOf)),
				`getEvents(${stringify(filter)})`,
			).toEqual(expected);
			expect(
				envelopeBatches.map((batch) => batch.map(({ metadata }) => metadata.version)),
				`getEnvelopes(${stringify(filter)})`,
			).toEqual(expected);
		};

		/**
		 * Asserts the versions that getEvents() and getEnvelopes() read from the reference stream.
		 */
		const expectVersions = async (filter: Omit<IEventFilter, 'pool'>, expected: number[]) => {
			const events = await drain(readEvents(reference, filter));
			const envelopes = await drain(readEnvelopes(reference, filter));

			expect(events.map(seqOf), `getEvents(${stringify(filter)})`).toEqual(expected);
			expect(
				envelopes.map(({ metadata }) => metadata.version),
				`getEnvelopes(${stringify(filter)})`,
			).toEqual(expected);
		};

		/**
		 * Asserts that the store still serves reads and writes, within a timeout.
		 */
		const expectStoreToBeUsable = (description: string) =>
			withinTimeout(
				(async () => {
					await expect(call(() => store.getEvent(reference, 7, pool))).resolves.toEqual(referenceEvents[6]);
					expect((await drain(readEvents(reference))).map(seqOf)).toEqual(range(1, 7));
					await expect(store.appendEvents(newEventStream(), 1, recordedEvents(1), pool)).resolves.toHaveLength(1);
				})(),
				`Store calls ${description}`,
			);

		/**
		 * Asserts that consumers that stop early, or throw, leave the store usable.
		 */
		const expectReadersToRelease = async (
			readers: [string, () => AsyncGenerator<unknown[]>][],
			stop: 'break' | 'throw',
		) => {
			for (const [method, read] of readers) {
				for (let iteration = 0; iteration < LEAK_PROBE_ITERATIONS; iteration++) {
					if (stop === 'break') {
						await withinTimeout(
							(async () => {
								for await (const batch of read()) {
									expect(batch.length).toBeGreaterThan(0);
									break;
								}
							})(),
							`Breaking out of ${method}()`,
						);
					} else {
						const failure = new Error(`Consumer of ${method}() failed`);
						const consume = async () => {
							for await (const _batch of read()) {
								throw failure;
							}
						};
						await expect(withinTimeout(consume(), `Throwing out of ${method}()`)).rejects.toBe(failure);
					}
				}
				await expectStoreToBeUsable(`after ${stop === 'break' ? 'breaking' : 'throwing'} out of ${method}()`);
			}
		};

		beforeAll(async () => {
			handle = await factory(context);
			store = handle.store;
			capabilities = resolveCapabilities(store.capabilities);

			await store.ensureCollection(pool);

			referenceEnvelopes = [
				...(await store.appendEvents(reference, 4, referenceEvents.slice(0, 4), pool)),
				...(await store.appendEvents(reference, 7, referenceEvents.slice(4), pool)),
			];
		}, timeout);

		afterEach(() => {
			publisher.failWith(undefined);
		});

		afterAll(async () => {
			await handle?.cleanup([
				collection,
				...createdPools.map((createdPool) => EventCollection.get(createdPool)),
				EventCollection.get(unknownPool),
			]);
		}, timeout);

		group('appending', () => {
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
				const eventIds = idsOf(envelopes);
				expect([...eventIds].sort()).toEqual(eventIds);
				expect(new Set(eventIds).size).toBe(3);
			});

			for (const count of [1, 25, 26]) {
				test('append-sizes', `appends ${count} event(s) at once`, async () => {
					const stream = newEventStream();

					const envelopes = await store.appendEvents(stream, count, recordedEvents(count), pool);

					expect(versionsOf(envelopes)).toEqual(range(1, count));
					expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, count));
					expect(versionsOf(await drain(readEnvelopes(stream)))).toEqual(range(1, count));
					await expect(call(() => store.getEvent(stream, count, pool))).resolves.toEqual(
						new ConformanceRecorded(count),
					);
				});
			}

			test('append-continues-stream', 'continues a stream where the previous append ended', async () => {
				expect(versionsOf(referenceEnvelopes)).toEqual(range(1, 7));
				expect((await drain(readEnvelopes(reference))).map(describeEnvelope)).toEqual(
					referenceEnvelopes.map(describeEnvelope),
				);
			});

			test('append-empty-noop', 'returns no envelopes for an empty append, without any I/O', async () => {
				const stream = newEventStream();
				await append(stream, recordedEvents(2), ExpectedVersion.NoStream);

				await expectNoIo('an empty append', async () => {
					// The expected version isn't checked: there is nothing to append
					for (const expectedVersion of [ExpectedVersion.NoStream, 2, 5, ExpectedVersion.Any]) {
						await expect(append(stream, [], expectedVersion)).resolves.toEqual([]);
					}
					await expect(append(newEventStream(), [], ExpectedVersion.NoStream)).resolves.toEqual([]);
				});
				expect(versionsOf(await drain(readEnvelopes(stream)))).toEqual([1, 2]);
			});

			test(
				'append-envelope-contiguity',
				'rejects pre-built envelopes that do not continue the stream, without any I/O',
				async () => {
					const stream = newEventStream();
					await append(stream, recordedEvents(2), ExpectedVersion.NoStream);
					const other = newEventStream();
					const envelope = (version: number, target = stream) =>
						envelopeFor(target, new ConformanceRecorded(version), version);

					await expectNoIo('non-contiguous envelopes', async () => {
						const cases: [string, (IEvent | EventEnvelope)[], ExpectedVersion, Record<string, unknown>][] = [
							['another aggregate', [envelope(3, other)], 2, { reason: 'aggregate-id', index: 0 }],
							['a version gap', [envelope(4)], 2, { reason: 'version', index: 0, expected: 3, actual: 4 }],
							['a taken version', [envelope(2)], 2, { reason: 'version', expected: 3, actual: 2 }],
							['versions out of order', [envelope(4), envelope(3)], 2, { reason: 'version', index: 0 }],
							[
								'a mixed array with a gap',
								[new ConformanceRecorded(3), envelope(5)],
								2,
								{ reason: 'version', index: 1, expected: 4, actual: 5 },
							],
							['ExpectedVersion.Any', [envelope(3)], ExpectedVersion.Any, { reason: 'expected-version-any' }],
						];
						for (const [description, items, expectedVersion, fields] of cases) {
							const error = await rejectionOf(append(stream, items, expectedVersion));
							expect(isEventSourcingError(error, EventSourcingErrorCode.InvalidEventEnvelope), `${description}`).toBe(
								true,
							);
							expect(error, `${description}`).toMatchObject({ streamId: stream.streamId, ...fields });
						}
					});
					expect(versionsOf(await drain(readEnvelopes(stream)))).toEqual([1, 2]);

					// A mixed array that continues the stream is accepted, whatever the order of its events and envelopes
					const appended = await append(stream, [new ConformanceRecorded(3), envelope(4)], 2);
					expect(versionsOf(appended)).toEqual([3, 4]);
					const envelopeFirst = await append(stream, [envelope(5), new ConformanceRecorded(6)], 4);
					expect(versionsOf(envelopeFirst)).toEqual([5, 6]);
					expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, 6));
				},
			);

			test(
				'append-envelope-preserved',
				'keeps the id, time and metadata of a pre-built envelope, and leaves the envelope as it was',
				async () => {
					const stream = newEventStream();
					const occurredOn = new Date('2021-03-04T05:06:07.089Z');
					const event = new ConformanceRecorded(1, 'imported');
					const input = EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
						aggregateId: stream.aggregateId,
						version: 1,
						eventId: EventId.generate(occurredOn),
						correlationId: 'imported-correlation',
						causationId: 'imported-causation',
						eventVersion: 2,
						...(capabilities.headers ? { headers: { $traceparent: '00-abc-def-01', tenant: 'acme' } } : {}),
					}).withGlobalPosition(987_654_321n);
					const snapshot = describeStored(input);

					const [stored] = await append(stream, [input], ExpectedVersion.NoStream);

					// The input is left as it was
					expect(describeStored(input)).toEqual(snapshot);
					expect(stored).not.toBe(input);

					// The store assigns the position, whatever the envelope carried
					expect(typeof stored.metadata.globalPosition).toBe('bigint');
					expect(stored.metadata.globalPosition).not.toBe(987_654_321n);
					const expected = { ...snapshot, globalPosition: stored.metadata.globalPosition };
					expect(describeStored(stored)).toEqual(expected);
					expect(describeStored(await store.getEnvelope(stream, 1, pool))).toEqual(expected);
					expect((await drain(readEnvelopes(stream))).map(describeStored)).toEqual([describeStored(stored)]);
				},
			);

			test(
				'append-deprecated-positional',
				'keeps the deprecated positional form working like the options form',
				async () => {
					const positional = newEventStream();
					const withOptions = newEventStream();

					const fromPositional = await store.appendEvents(positional, 2, recordedEvents(2), pool);
					const fromOptions = await append(withOptions, recordedEvents(2), ExpectedVersion.NoStream);
					expect(versionsOf(fromPositional)).toEqual(versionsOf(fromOptions));
					expect(fromPositional.map(({ event, payload }) => ({ event, payload }))).toEqual(
						fromOptions.map(({ event, payload }) => ({ event, payload })),
					);
					expect(versionsOf(await store.appendEvents(positional, 3, recordedEvents(1, 3), pool))).toEqual([3]);

					// An empty append does nothing
					await expect(store.appendEvents(positional, 3, [], pool)).resolves.toEqual([]);
					// The version of the aggregate after the append leaves a gap: expected 4, the stream is at 3
					await expectRejectionOfClass(
						store.appendEvents(positional, 5, recordedEvents(1, 5), pool),
						EventStoreVersionConflictException,
						{ expectedVersion: 4, actualVersion: 3 },
					);
					expect(versionsOf(await drain(readEnvelopes(positional)))).toEqual([1, 2, 3]);
				},
			);

			test(
				'append-atomic-partial-failure',
				'stores nothing of an append that fails halfway, and burns no positions',
				async () => {
					const faults = handle?.faults;
					if (!faults) {
						throw new Error(
							"The store claims atomicAppend, but its conformance handle injects no write failures: provide `faults`, or skip 'append-atomic-partial-failure' with a reason",
						);
					}
					const atomicPool = await createPool('atomic');
					const [probe] = await append(newEventStream(), recordedEvents(1), ExpectedVersion.NoStream, atomicPool);

					const stream = newEventStream();
					const removeFault = await faults.failInsertOf(
						EventCollection.get(atomicPool),
						eventMap.getName(new ConformancePayloadProbed({})),
					);
					try {
						await expectRejectionOfClass(
							append(
								stream,
								[
									new ConformanceRecorded(1),
									new ConformancePayloadProbed({ poisoned: true }),
									new ConformanceRecorded(3),
								],
								ExpectedVersion.NoStream,
								atomicPool,
							),
							EventStorePersistenceException,
							{ outcome: 'not-persisted' },
						);
					} finally {
						await removeFault();
					}

					expect(
						await drain(store.getEnvelopes(stream, { pool: atomicPool })),
						'the events of the failed append',
					).toEqual([]);
					await expect(store.getStreamVersion(stream, atomicPool)).resolves.toBe(0);
					const read = await readAllOf(atomicPool);
					expect(idsOf(read)).toEqual(idsOf([probe]));

					// The next append continues right after the last stored position
					const next = await append(stream, recordedEvents(2), ExpectedVersion.NoStream, atomicPool);
					expect(positionsOf(next)).toEqual([
						(probe.metadata.globalPosition as bigint) + 1n,
						(probe.metadata.globalPosition as bigint) + 2n,
					]);
				},
				{ requires: ({ atomicAppend }) => (atomicAppend ? undefined : 'atomicAppend') },
			);
		});

		group('expected versions', () => {
			test('expected-exact', 'appends when the stream is at the expected version', async () => {
				const stream = newEventStream();

				expect(versionsOf(await append(stream, recordedEvents(2), ExpectedVersion.NoStream))).toEqual([1, 2]);
				expect(versionsOf(await append(stream, recordedEvents(1, 3), 2))).toEqual([3]);
				expect(versionsOf(await append(stream, recordedEvents(2, 4), 3))).toEqual([4, 5]);

				expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, 5));
				await expect(store.getStreamVersion(stream, pool)).resolves.toBe(5);
				await expect(store.getStreamVersion(newEventStream(), pool)).resolves.toBe(0);
			});

			test('expected-stale', 'rejects an append that expects an older version, and writes nothing', async () => {
				const stream = newEventStream();
				await append(stream, recordedEvents(3), ExpectedVersion.NoStream);

				for (const expectedVersion of [2, 1]) {
					await expectRejectionOfClass(
						append(stream, [new ConformanceRecorded(99, 'stale')], expectedVersion),
						EventStoreVersionConflictException,
						{ expectedVersion, actualVersion: 3 },
					);
				}
				expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, 3));
			});

			test(
				'expected-gap',
				'rejects an append that expects a newer version, writes nothing and burns no position',
				async () => {
					const stream = newEventStream();
					const seeded = await append(stream, recordedEvents(3), ExpectedVersion.NoStream);

					await expectRejectionOfClass(
						append(stream, [new ConformanceRecorded(6, 'gap')], 5),
						EventStoreVersionConflictException,
						{ expectedVersion: 5, actualVersion: 3 },
					);
					expect((await drain(readEvents(stream))).map(seqOf)).toEqual(range(1, 3));

					const [next] = await append(stream, recordedEvents(1, 4), 3);
					expect(next.metadata.version).toBe(4);
					expect(typeof seeded[2].metadata.globalPosition, 'the position of the last seeded event').toBe('bigint');
					expect(next.metadata.globalPosition).toBe((seeded[2].metadata.globalPosition as bigint) + 1n);
				},
			);

			test('no-stream-on-existing', 'rejects ExpectedVersion.NoStream for a stream that has events', async () => {
				const stream = newEventStream();
				await append(stream, recordedEvents(2), ExpectedVersion.NoStream);

				await expectRejectionOfClass(
					append(stream, recordedEvents(1, 3), ExpectedVersion.NoStream),
					EventStoreVersionConflictException,
					{ expectedVersion: 0, actualVersion: 2 },
				);
				expect((await drain(readEvents(stream))).map(seqOf)).toEqual([1, 2]);
			});

			test(
				'expected-invalid',
				'rejects an invalid expected version with an InvalidAppendOptionsException, without any I/O',
				async () => {
					const stream = newEventStream();
					await expectNoIo('an invalid expected version', async () => {
						for (const expectedVersion of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'x', undefined, null]) {
							await expectRejectionOfClass(
								store.appendEvents(stream, recordedEvents(1), { expectedVersion } as never),
								InvalidAppendOptionsException,
								{ option: 'expectedVersion' },
							);
						}
						// The positional form: the aggregate version after the append is below the number of events
						await expectRejectionOfClass(
							store.appendEvents(stream, 1, recordedEvents(2), pool),
							InvalidAppendOptionsException,
						);
						await expectRejectionOfClass(
							store.appendEvents(stream, recordedEvents(1), { expectedVersion: 0, pool: '' }),
							InvalidAppendOptionsException,
							{ option: 'pool' },
						);
					});
					expect(await drain(readEvents(stream))).toEqual([]);
				},
			);
		});

		group('reading', () => {
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
				async (context) => {
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

					const appended = await store.appendEvents(stream, 3, envelopes, pool);

					const expected = envelopes.map(describeEnvelope);
					expect((await drain(readEnvelopes(stream))).map(describeEnvelope)).toEqual(expected);
					for (const [index, envelope] of expected.entries()) {
						expect(describeEnvelope(await call(() => store.getEnvelope(stream, index + 1, pool)))).toEqual(envelope);
					}

					await readAllPart(context, async () => {
						const fromAll = await readAllOf(pool, appended[0].metadata.globalPosition);
						expect(fromAll.slice(0, 3).map(describeEnvelope)).toEqual(expected);
					});
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

		group('read filters', () => {
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

		group('optimistic concurrency', () => {
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
					async (context) => {
						const stream = newEventStream();
						if (seeded) {
							await store.appendEvents(stream, seeded, recordedEvents(seeded), pool);
						}
						const target = seeded + 2;
						// Atomic stores burn no position for the appends that lose
						const checkPositions = capabilities.atomicAppend && readsAll();
						const lastPosition = checkPositions ? await lastPositionOf(pool) : 0n;
						const mark = publisher.mark();

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
							result.status === 'rejected' &&
							!isEventSourcingError(result.reason, EventSourcingErrorCode.EventStoreVersionConflict)
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

						// Only the winner is published: the appends that lost stored nothing
						const winner = (results[winners[0]] as PromiseFulfilledResult<EventEnvelope[]>).value;
						expect(publisher.callsSince(mark).map(idsOf), 'the published appends').toEqual([idsOf(winner)]);

						if (checkPositions) {
							expect(positionsOf(winner)).toEqual([lastPosition + 1n, lastPosition + 2n]);
							expect(idsOf(await readAllOf(pool, lastPosition + 1n))).toEqual(idsOf(winner));
						} else if (capabilities.atomicAppend) {
							await context.annotate('readAll part skipped: read-all-order is skipped for this store');
						}
					},
				);
			}

			test('conflict-fields', 'describes a conflict in the fields of the exception', async () => {
				const stream = newEventStream();
				await append(stream, recordedEvents(2), ExpectedVersion.NoStream);

				// Found by the check of the expected version: the actual version is known
				const checked = await rejectionOf(append(stream, recordedEvents(1, 3), 1));
				expect(isEventSourcingError(checked, EventSourcingErrorCode.EventStoreVersionConflict)).toBe(true);
				expect(checked).toMatchObject({
					code: EventSourcingErrorCode.EventStoreVersionConflict,
					streamId: stream.streamId,
					aggregateId: stream.aggregateId,
					pool,
					expectedVersion: 1,
					actualVersion: 2,
				});

				// Lost on the unique (stream, version) key, after the check passed: the store reports what it knows
				const staleRead = spyOnStore('getStreamVersion').mockResolvedValueOnce(1);
				let raced: unknown;
				try {
					raced = await rejectionOf(append(stream, recordedEvents(1, 2, 'raced'), 1));
				} finally {
					staleRead.mockRestore();
				}
				expect(isEventSourcingError(raced, EventSourcingErrorCode.EventStoreVersionConflict)).toBe(true);
				expect(raced).toMatchObject({ streamId: stream.streamId, pool, expectedVersion: 1 });
				const { actualVersion, cause } = raced as EventStoreVersionConflictException;
				expect(actualVersion === undefined || typeof actualVersion === 'number').toBe(true);
				expect(cause, 'the cause of a conflict on the unique key').toBeDefined();

				const events = (await drain(readEvents(stream))) as ConformanceRecorded[];
				expect(events.map(({ writer }) => writer)).not.toContain('raced');
			});

			test(
				'concurrent-any',
				`appends every one of ${CONCURRENT_WRITERS} concurrent appends with ExpectedVersion.Any`,
				async () => {
					const stream = newEventStream();

					const appended = await withinTimeout(
						allSettledOrThrow(
							Array.from({ length: CONCURRENT_WRITERS }, (_, writer) =>
								append(stream, recordedEvents(2, 1, `writer-${writer}`), ExpectedVersion.Any),
							),
						),
						'Concurrent appends with ExpectedVersion.Any',
						heavyTimeout,
					);

					for (const [writer, envelopes] of appended.entries()) {
						const [first] = versionsOf(envelopes);
						expect(versionsOf(envelopes), `the versions of writer ${writer}`).toEqual([first, first + 1]);
						expectConsecutive(envelopes, `the positions of writer ${writer}`);
					}
					expect(appended.flatMap(versionsOf).sort((a, b) => a - b)).toEqual(range(1, CONCURRENT_WRITERS * 2));

					// Each append is stored as one block, with its event ids
					const read = await drain(readEnvelopes(stream));
					expect(versionsOf(read)).toEqual(range(1, CONCURRENT_WRITERS * 2));
					for (const envelopes of appended) {
						const [first] = versionsOf(envelopes);
						expect(idsOf(read.slice(first - 1, first + 1))).toEqual(idsOf(envelopes));
					}
				},
				heavyTimeout,
			);
		});

		group('pools', () => {
			test(
				'unknown-pool-append',
				'rejects an append to a pool whose collection was never created, without creating it',
				async () => {
					const error = await rejectionOf(store.appendEvents(newEventStream(), 1, recordedEvents(1), unknownPool));
					expect(isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)).toBe(true);
					expect(error).toMatchObject({
						code: EventSourcingErrorCode.EventStorePersistence,
						outcome: 'not-persisted',
						collection: EventCollection.get(unknownPool),
					});
					expect(
						isEventSourcingError((error as Error).cause, EventSourcingErrorCode.EventCollectionNotFound),
						`the cause ${String((error as Error).cause)}`,
					).toBe(true);
					expect(await drain(store.listCollections())).not.toContain(EventCollection.get(unknownPool));
				},
			);

			test(
				'unknown-pool-read',
				'rejects reads from a pool whose collection was never created with an EventCollectionNotFoundException',
				async () => {
					const filter = { pool: unknownPool };
					const fields = { collection: EventCollection.get(unknownPool), pool: unknownPool };
					await expectRejectionOfClass(
						drain(store.getEvents(reference, filter)),
						EventCollectionNotFoundException,
						fields,
					);
					await expectRejectionOfClass(
						drain(store.getEnvelopes(reference, filter)),
						EventCollectionNotFoundException,
						fields,
					);
					await expectRejectionOfClass(
						call(() => store.getEvent(reference, 1, unknownPool)),
						EventCollectionNotFoundException,
						fields,
					);
					await expectRejectionOfClass(
						call(() => store.getEnvelope(reference, 1, unknownPool)),
						EventCollectionNotFoundException,
						fields,
					);
					await expectRejectionOfClass(drain(store.readAll(filter)), EventCollectionNotFoundException, fields);
				},
			);

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
				expect(new Set(collections).size).toBe(collections.length);

				expect(await drain(store.listCollections())).toEqual(expect.arrayContaining([collection]));
			});
		});

		group('template', () => {
			test(
				'template-not-overridden',
				'leaves appendEvents, getEvent and getEvents to the EventStore base class',
				async () => {
					expect(() => assertEventStoreImplementation(store)).not.toThrow();
					expect(store).toBeInstanceOf(EventStore);
					for (const method of ['appendEvents', 'getEvent', 'getEvents'] as const) {
						expect(store[method], `${method}`).toBe(EventStore.prototype[method]);
					}
				},
			);
		});

		group('publishing', () => {
			test('publish-committed-once', 'publishes the stored envelopes once, as they were returned', async () => {
				const stream = newEventStream();

				const mark = publisher.mark();
				const appended = await append(stream, recordedEvents(3), ExpectedVersion.NoStream);
				expect(publisher.callsSince(mark)).toEqual([appended]);

				const anyMark = publisher.mark();
				const appendedAny = await append(stream, recordedEvents(1, 4), ExpectedVersion.Any);
				expect(publisher.callsSince(anyMark)).toEqual([appendedAny]);
				expect(positionsOf(publisher.callsSince(anyMark)[0])).toEqual(positionsOf(appendedAny));
			});

			test('publish-false-skips-publisher', 'stores without publishing when publish is false', async () => {
				const stream = newEventStream();

				const mark = publisher.mark();
				const appended = await store.appendEvents(stream, recordedEvents(2), {
					expectedVersion: ExpectedVersion.NoStream,
					pool,
					publish: false,
				});
				expect(publisher.callsSince(mark)).toEqual([]);
				expect(idsOf(await drain(readEnvelopes(stream)))).toEqual(idsOf(appended));
			});

			test('conflict-publishes-nothing', 'publishes nothing for an append that conflicts', async () => {
				const stream = newEventStream();
				await append(stream, recordedEvents(2), ExpectedVersion.NoStream);

				const mark = publisher.mark();
				await expectRejectionOfClass(
					append(stream, recordedEvents(1, 3), ExpectedVersion.NoStream),
					EventStoreVersionConflictException,
				);
				await expectRejectionOfClass(
					store.appendEvents(stream, 2, recordedEvents(1, 2), pool),
					EventStoreVersionConflictException,
				);
				expect(publisher.callsSince(mark)).toEqual([]);
			});

			test(
				'publisher-failure-does-not-reject',
				'resolves an append whose publisher fails, since the events are stored',
				async () => {
					for (const synchronously of [false, true]) {
						const stream = newEventStream();
						publisher.failWith(new Error('publisher failed'), { synchronously });

						const mark = publisher.mark();
						const appended = await append(stream, recordedEvents(2), ExpectedVersion.NoStream);

						expect(publisher.callsSince(mark)).toEqual([appended]);
						expect(idsOf(await drain(readEnvelopes(stream)))).toEqual(idsOf(appended));
						publisher.failWith(undefined);
					}
				},
			);
		});

		group('metadata', () => {
			test(
				'metadata-round-trip',
				'stores the correlation id and causation id of the options, and keeps those of pre-built envelopes',
				async (context) => {
					const stream = newEventStream();
					const metadata = { correlationId: `correlation-${stream.aggregateId}`, causationId: 'command-1' };

					const mark = publisher.mark();
					const appended = await store.appendEvents(stream, recordedEvents(2), {
						expectedVersion: ExpectedVersion.NoStream,
						pool,
						metadata,
					});
					const prebuilt = EventEnvelope.create(
						eventMap.getName(new ConformanceRecorded(4)),
						eventMap.serializeEvent(new ConformanceRecorded(4)),
						{ aggregateId: stream.aggregateId, version: 4, correlationId: 'own-correlation' },
					);
					const mixed = await store.appendEvents(stream, [new ConformanceRecorded(3), prebuilt], {
						expectedVersion: 2,
						pool,
						metadata: { correlationId: 'options-correlation', causationId: 'command-2' },
					});

					const expected = [
						{ correlationId: metadata.correlationId, causationId: 'command-1' },
						{ correlationId: metadata.correlationId, causationId: 'command-1' },
						{ correlationId: 'options-correlation', causationId: 'command-2' },
						// The fields of a pre-built envelope win; the options fill the ones it lacks
						{ correlationId: 'own-correlation', causationId: 'command-2' },
					];
					const idsOfMetadata = (envelopes: readonly EventEnvelope[]) =>
						envelopes.map(({ metadata: { correlationId, causationId } }) => ({ correlationId, causationId }));

					expect(idsOfMetadata([...appended, ...mixed]), 'returned').toEqual(expected);
					expect(idsOfMetadata(publisher.callsSince(mark).flat()), 'published').toEqual(expected);
					expect(idsOfMetadata(await drain(readEnvelopes(stream))), 'getEnvelopes()').toEqual(expected);
					expect(idsOfMetadata([await store.getEnvelope(stream, 4, pool)]), 'getEnvelope()').toEqual([expected[3]]);
					await readAllPart(context, async () => {
						const fromAll = await readAllOf(pool, appended[0].metadata.globalPosition);
						expect(
							idsOfMetadata(fromAll.filter(({ metadata }) => metadata.aggregateId === stream.aggregateId)),
							'readAll()',
						).toEqual(expected);
					});
				},
			);

			test(
				'headers-round-trip',
				'stores the headers of the options and of pre-built envelopes',
				async (context) => {
					const stream = newEventStream();
					const headers = { string: 'text', number: 42.5, boolean: false, nothing: null, 'ünïcødé-キー': 'värde' };

					const mark = publisher.mark();
					const withHeaders = await store.appendEvents(stream, recordedEvents(1), {
						expectedVersion: ExpectedVersion.NoStream,
						pool,
						metadata: { headers },
					});
					const withoutHeaders = await append(stream, recordedEvents(1, 2), 1);
					const prebuilt = EventEnvelope.create(
						eventMap.getName(new ConformanceRecorded(3)),
						eventMap.serializeEvent(new ConformanceRecorded(3)),
						{ aggregateId: stream.aggregateId, version: 3, headers: { $traceparent: '00-trace-span-01', tenant: 'a' } },
					);
					const imported = await store.appendEvents(stream, [prebuilt], {
						expectedVersion: 2,
						pool,
						// A pre-built envelope keeps its own headers
						metadata: { headers: { tenant: 'b' } },
					});

					const expected = [headers, undefined, { $traceparent: '00-trace-span-01', tenant: 'a' }];
					const headersOf = (envelopes: readonly EventEnvelope[]) => envelopes.map(({ metadata }) => metadata.headers);

					expect(headersOf([...withHeaders, ...withoutHeaders, ...imported]), 'returned').toEqual(expected);
					expect(headersOf(publisher.callsSince(mark).flat()), 'published').toEqual(expected);
					const read = await drain(readEnvelopes(stream));
					expect(headersOf(read), 'getEnvelopes()').toEqual(expected);
					expect(read[1].metadata.headers, 'absent headers').toBeUndefined();
					for (const version of [1, 2, 3]) {
						expect(headersOf([await store.getEnvelope(stream, version, pool)]), `getEnvelope(${version})`).toEqual([
							expected[version - 1],
						]);
					}
					await readAllPart(context, async () => {
						const fromAll = await readAllOf(pool, withHeaders[0].metadata.globalPosition);
						expect(
							headersOf(fromAll.filter(({ metadata }) => metadata.aggregateId === stream.aggregateId)),
							'readAll()',
						).toEqual(expected);
					});
				},
				{ requires: ({ headers }) => (headers ? undefined : 'headers') },
			);

			test(
				'headers-unsupported-rejects',
				'rejects headers with an UnsupportedOperationException, without any I/O',
				async () => {
					const stream = newEventStream();
					const prebuilt = EventEnvelope.create(
						eventMap.getName(new ConformanceRecorded(1)),
						eventMap.serializeEvent(new ConformanceRecorded(1)),
						{ aggregateId: stream.aggregateId, version: 1, headers: { tenant: 'a' } },
					);

					await expectNoIo('headers on a store without headers', async () => {
						await expectRejectionOfClass(
							store.appendEvents(stream, recordedEvents(1), {
								expectedVersion: ExpectedVersion.NoStream,
								pool,
								metadata: { headers: { tenant: 'a' } },
							}),
							UnsupportedOperationException,
							{ operation: 'headers' },
						);
						await expectRejectionOfClass(
							append(stream, [prebuilt], ExpectedVersion.NoStream),
							UnsupportedOperationException,
							{ operation: 'headers' },
						);
					});
					expect(await drain(readEvents(stream))).toEqual([]);
				},
				{ requires: ({ headers }) => (headers ? 'headers: false (the store supports headers)' : undefined) },
			);

			test(
				'metadata-validation-no-io',
				'rejects invalid metadata with an InvalidEventMetadataException, without any I/O',
				async () => {
					const stream = newEventStream();
					const invalid: [string, unknown, Record<string, unknown>][] = [
						['a reserved header key', { headers: { $tenant: 'a' } }, { field: 'headers', reason: 'reserved-key' }],
						['an empty header key', { headers: { '': 'a' } }, { field: 'headers', reason: 'empty-key' }],
						['an object header value', { headers: { a: { b: 1 } } }, { field: 'headers', reason: 'invalid-value' }],
						['a NaN header value', { headers: { a: Number.NaN } }, { field: 'headers', reason: 'invalid-value' }],
						['headers over 8 KiB', { headers: { a: 'x'.repeat(8 * 1024) } }, { field: 'headers', reason: 'too-large' }],
						[
							'a long correlation id',
							{ correlationId: 'c'.repeat(256) },
							{ field: 'correlationId', reason: 'too-long' },
						],
						['a long causation id', { causationId: 'c'.repeat(256) }, { field: 'causationId', reason: 'too-long' }],
						['a numeric correlation id', { correlationId: 42 }, { field: 'correlationId', reason: 'invalid-type' }],
					];

					await expectNoIo('invalid metadata', async () => {
						for (const [description, metadata, fields] of invalid) {
							const error = await rejectionOf(
								store.appendEvents(stream, recordedEvents(1), {
									expectedVersion: ExpectedVersion.NoStream,
									pool,
									metadata: metadata as never,
								}),
							);
							expect(isEventSourcingError(error, EventSourcingErrorCode.InvalidEventMetadata), `${description}`).toBe(
								true,
							);
							expect(error, `${description}`).toMatchObject(fields);
						}
					});
					expect(await drain(readEvents(stream))).toEqual([]);
				},
			);
		});

		group('readAll', () => {
			test(
				'read-all-order',
				'reads a pool across streams in commit order, with the positions the appends returned',
				async () => {
					const orderPool = await createPool('order');
					const [a, b, c] = [newEventStream(), newEventStream(), newEventStream()];

					const mark = publisher.mark();
					const appends = [
						await append(a, recordedEvents(2, 1, 'a'), ExpectedVersion.NoStream, orderPool),
						await append(b, recordedEvents(1, 1, 'b'), ExpectedVersion.NoStream, orderPool),
						await append(a, recordedEvents(1, 3, 'a'), 2, orderPool),
						await append(c, recordedEvents(3, 1, 'c'), ExpectedVersion.NoStream, orderPool),
						await append(b, recordedEvents(2, 2, 'b'), ExpectedVersion.Any, orderPool),
					];
					const appended = appends.flat();

					for (const [index, envelopes] of appends.entries()) {
						expectConsecutive(envelopes, `the positions of append ${index}`);
					}
					expectStrictlyIncreasing(positionsOf(appended), 'the positions of the appends');
					expect(appended[0].metadata.globalPosition, 'the first position of a pool').toBe(1n);

					const read = await readAllOf(orderPool);
					expect(read.map(describeStored)).toEqual(appended.map(describeStored));
					expect(positionsOf(publisher.callsSince(mark).flat())).toEqual(positionsOf(appended));
					expect(read.map(({ metadata }) => metadata.aggregateId)).toEqual([
						a.aggregateId,
						a.aggregateId,
						b.aggregateId,
						a.aggregateId,
						c.aggregateId,
						c.aggregateId,
						c.aggregateId,
						b.aggregateId,
						b.aggregateId,
					]);
				},
			);

			test(
				'read-all-positions-on-reads',
				'returns the global position of every event from getEnvelope and getEnvelopes',
				async () => {
					const stream = newEventStream();
					const appended = await append(stream, recordedEvents(3), ExpectedVersion.NoStream);

					expectConsecutive(appended, 'the appended positions');
					expect(positionsOf(await drain(readEnvelopes(stream)))).toEqual(positionsOf(appended));
					expect(
						positionsOf(await drain(readEnvelopes(stream, { direction: StreamReadingDirection.BACKWARD }))),
					).toEqual(positionsOf(appended).reverse());
					for (const envelope of appended) {
						expect((await store.getEnvelope(stream, envelope.metadata.version, pool)).metadata.globalPosition).toBe(
							envelope.metadata.globalPosition,
						);
					}
				},
			);

			test('read-all-resume', 'resumes at every position, inclusive, in batches of any size, per pool', async () => {
				const [first, second] = [await createPool('resume-a'), await createPool('resume-b')];
				const [a, b, c] = [newEventStream(), newEventStream(), newEventStream()];

				const appendedFirst: EventEnvelope[] = [];
				const appendedSecond: EventEnvelope[] = [];
				appendedFirst.push(...(await append(a, recordedEvents(2), ExpectedVersion.NoStream, first)));
				appendedSecond.push(...(await append(c, recordedEvents(2), ExpectedVersion.NoStream, second)));
				appendedFirst.push(...(await append(b, recordedEvents(1), ExpectedVersion.NoStream, first)));
				appendedFirst.push(...(await append(a, recordedEvents(2, 3), 2, first)));
				appendedSecond.push(...(await append(c, recordedEvents(1, 3), 2, second)));

				const inFirst = await readAllOf(first);
				expect(idsOf(inFirst)).toEqual(idsOf(appendedFirst));
				expect(positionsOf(inFirst)).toEqual(positionsOf(appendedFirst));
				// The pools are independent
				const inSecond = await readAllOf(second);
				expect(idsOf(inSecond)).toEqual(idsOf(appendedSecond));
				expect(positionsOf(inSecond)[0], 'the first position of the second pool').toBe(1n);

				const positions = positionsOf(inFirst) as bigint[];
				const last = positions[positions.length - 1];
				for (const fromPosition of [undefined, 0n, ...positions, last + 1n, last + 10n]) {
					const expected = inFirst.filter(
						({ metadata }) => (metadata.globalPosition as bigint) >= (fromPosition ?? 0n),
					);
					for (let batch = 1; batch <= inFirst.length + 1; batch++) {
						const description = `readAll(${stringify({ fromPosition, batch })})`;
						const batches = await collectBatches(store.readAll({ pool: first, fromPosition, batch }));
						expect(idsOf(batches.flat()), `${description}`).toEqual(idsOf(expected));
						expect(
							batches.map((read) => read.length),
							`${description}: batches`,
						).toEqual(
							Array.from({ length: Math.ceil(expected.length / batch) }, (_, index) =>
								Math.min(batch, expected.length - index * batch),
							),
						);
					}
				}
			});

			test(
				'read-all-gap-safe',
				`hands every event to a reader that tails ${CONCURRENT_WRITERS} concurrent writers exactly once`,
				async () => {
					const gapSafePool = await createPool('gap-safe');
					let writing = true;

					const writerPromises = Array.from({ length: CONCURRENT_WRITERS }, async (_, writer) => {
						const stream = newEventStream();
						const envelopes: EventEnvelope[] = [];
						for (let index = 0; index < GAP_SAFE_APPENDS_PER_WRITER; index++) {
							const count = 1 + ((writer + index) % 3);
							envelopes.push(
								...(await append(
									stream,
									recordedEvents(count, envelopes.length + 1, `writer-${writer}`),
									envelopes.length,
									gapSafePool,
								)),
							);
							// Lets the reader in between the appends, also on a store whose appends wait for no I/O. A store that
							// makes positions readable out of order is caught when that takes a timer or I/O, as it does in every
							// real store; a reorder within microtasks goes unnoticed.
							await yieldToEventLoop();
						}
						return envelopes;
					});
					const writers = allSettledOrThrow(writerPromises).finally(() => {
						writing = false;
					});
					// Awaited below; a failing reader must not leave its rejection unhandled
					writers.catch(() => undefined);

					const read: EventEnvelope[] = [];
					let readWhileWriting = 0;
					const readFromLast = async () => {
						const fromPosition = ((read.at(-1)?.metadata.globalPosition as bigint | undefined) ?? 0n) + 1n;
						read.push(...(await drain(store.readAll({ pool: gapSafePool, fromPosition, batch: 7 }))));
					};
					try {
						while (writing) {
							const before = read.length;
							await readFromLast();
							if (writing) {
								readWhileWriting += read.length - before;
							}
							await yieldToEventLoop();
						}
					} finally {
						await Promise.allSettled(writerPromises);
					}
					const appended = (await writers).flat();
					await readFromLast();

					expect(readWhileWriting, 'events the reader read while the writers were appending').toBeGreaterThan(0);
					expectStrictlyIncreasing(positionsOf(read), 'the positions the tailing reader read');
					const counts = new Map<string, number>();
					for (const id of idsOf(read)) {
						counts.set(id, (counts.get(id) ?? 0) + 1);
					}
					const missed = idsOf(appended).filter((id) => !counts.has(id));
					const repeated = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
					expect(missed, 'events the tailing reader never read').toEqual([]);
					expect(repeated, 'events the tailing reader read more than once').toEqual([]);
					expect(read).toHaveLength(appended.length);

					const positionById = new Map(
						appended.map(({ metadata }) => [metadata.eventId.value, metadata.globalPosition]),
					);
					expect(
						read.every(({ metadata }) => positionById.get(metadata.eventId.value) === metadata.globalPosition),
					).toBe(true);
				},
				{
					timeout: heavyTimeout,
					requires: ({ globalOrder }) => (globalOrder === 'gap-safe' ? undefined : "globalOrder: 'gap-safe'"),
				},
			);

			test(
				'read-all-best-effort',
				'reads every event of concurrent writers once they are done, in increasing positions',
				async () => {
					const bestEffortPool = await createPool('best-effort');

					const appended = (
						await allSettledOrThrow(
							Array.from({ length: CONCURRENT_WRITERS }, async (_, writer) => {
								const stream = newEventStream();
								const envelopes: EventEnvelope[] = [];
								for (let index = 0; index < 5; index++) {
									envelopes.push(
										...(await append(
											stream,
											recordedEvents(2, envelopes.length + 1, `writer-${writer}`),
											envelopes.length,
											bestEffortPool,
										)),
									);
								}
								return envelopes;
							}),
						)
					).flat();

					const read = await readAllOf(bestEffortPool);
					expectStrictlyIncreasing(positionsOf(read), 'the positions of readAll');
					expect([...idsOf(read)].sort()).toEqual([...idsOf(appended)].sort());
				},
				{
					timeout: heavyTimeout,
					requires: ({ globalOrder }) => (globalOrder === 'best-effort' ? undefined : "globalOrder: 'best-effort'"),
				},
			);
		});

		group('iteration', () => {
			const readers = (): [string, () => AsyncGenerator<unknown[]>][] => [
				['getEvents', () => readEvents(reference, { batch: 1 })],
				['getEnvelopes', () => readEnvelopes(reference, { batch: 1 })],
				['listCollections', () => store.listCollections({ batch: 1 })],
			];
			const readAllReaders = (): [string, () => AsyncGenerator<unknown[]>][] => [
				['readAll', () => store.readAll({ pool, batch: 1 })],
			];

			test(
				'early-break',
				'stays usable when a consumer stops reading early',
				() => expectReadersToRelease(readers(), 'break'),
				timeout * 2,
			);

			test(
				'consumer-throws',
				'stays usable when a consumer throws while reading',
				() => expectReadersToRelease(readers(), 'throw'),
				timeout * 2,
			);

			test(
				'read-all-early-break',
				'stays usable when a consumer stops reading all early',
				() => expectReadersToRelease(readAllReaders(), 'break'),
				timeout * 2,
			);

			test(
				'read-all-consumer-throws',
				'stays usable when a consumer throws while reading all',
				() => expectReadersToRelease(readAllReaders(), 'throw'),
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

		group('payloads', () => {
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
