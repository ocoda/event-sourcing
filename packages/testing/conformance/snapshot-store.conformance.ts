import {
	type ILatestSnapshotFilter,
	type ISnapshotFilter,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	type SnapshotStore,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	type SnapshotStream,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import {
	CALL_TIMEOUT,
	ConformanceAudit,
	ConformanceLedger,
	type ConformanceSnapshot,
	LEAK_PROBE_ITERATIONS,
	TEST_TIMEOUT,
	call,
	collectBatches,
	conformanceTest,
	createDatePayloadProbe,
	createJsonPayloadProbe,
	drain,
	expectRejection,
	expectRejectionOfClass,
	newSnapshotStream,
	uniquePoolName,
	withinTimeout,
} from './fixtures.js';
import type { ConformanceStoreHandle } from './types.js';

/**
 * A snapshot store with the optional envelope and bulk methods, which every store in this repository implements.
 */
export type ConformanceSnapshotStore = SnapshotStore<unknown> &
	Required<
		Pick<
			SnapshotStore<unknown>,
			'getEnvelope' | 'getEnvelopes' | 'getLastEnvelopesForAggregate' | 'getManyLastSnapshotEnvelopes'
		>
	>;

/**
 * Creates a connected snapshot store.
 */
export type SnapshotStoreConformanceFactory = () =>
	| ConformanceStoreHandle<ConformanceSnapshotStore>
	| Promise<ConformanceStoreHandle<ConformanceSnapshotStore>>;

export const SNAPSHOT_STORE_CONFORMANCE_CASES = [
	'append-returns-envelope',
	'latest-snapshot',
	'no-snapshot',
	'get-snapshot-by-version',
	'not-found',
	'envelope-metadata-round-trip',
	'registered-on-milliseconds',
	'filter-from-version',
	'filter-backward',
	'filter-backward-from-version',
	'filter-limit',
	'filter-batch',
	'filter-empty-results',
	'last-snapshots-bulk',
	'last-snapshots-empty-input',
	'last-snapshots-many-streams',
	'conflict-stale-version',
	'conflict-concurrent-appends',
	'aggregate-latest-only',
	'aggregate-limit',
	'aggregate-batch',
	'aggregate-order',
	'aggregate-cursor-paging',
	'unknown-pool-append',
	'unknown-pool-read',
	'ensure-collection-idempotent',
	'list-collections',
	'early-break',
	'consumer-throws',
	'nested-calls-during-iteration',
	'payload-json-fidelity',
	'payload-dates-as-iso-strings',
] as const;

export type SnapshotStoreConformanceCase = (typeof SNAPSHOT_STORE_CONFORMANCE_CASES)[number];

export interface SnapshotStoreConformanceOptions {
	/**
	 * The base name of the pools the suite creates. Defaults to a name that is unique to this run.
	 */
	pool?: string;
	/**
	 * Cases the store doesn't satisfy (yet), with the reason. They are reported as skipped.
	 */
	skip?: Partial<Record<SnapshotStoreConformanceCase, string>>;
	/**
	 * The timeout of a single test, in milliseconds.
	 */
	timeout?: number;
}

/**
 * The number of writers that race each other in the concurrency tests.
 */
const CONCURRENT_WRITERS = 8;

/**
 * The number of streams read at once by the 'many streams' bulk read, more than the default batch size (100).
 */
const MANY_STREAMS = 120;

/**
 * The versions of the snapshots in the reference stream.
 */
const REFERENCE_VERSIONS = [10, 20, 30, 40, 50, 60, 70];

const snapshotAt = (version: number, extra: Record<string, unknown> = {}): ConformanceSnapshot => ({
	state: { version, ...extra },
});

const versionOf = (snapshot: ConformanceSnapshot): number => (snapshot.state as { version: number }).version;

/**
 * The parts of an envelope that must survive a round trip through the store.
 */
const describeEnvelope = ({ payload, metadata }: SnapshotEnvelope<ConformanceLedger>) => ({
	payload,
	snapshotId: metadata.snapshotId,
	aggregateId: metadata.aggregateId,
	version: metadata.version,
});

const versions = (from: number, to: number) => REFERENCE_VERSIONS.filter((version) => version >= from && version <= to);

/**
 * Registers the snapshot store conformance suite: the contract that every snapshot store has to satisfy,
 * independent of the database behind it.
 *
 * The suite creates its own pools (named after `options.pool`, unique by default) and hands their collections to
 * `cleanup` once it is done.
 */
export const describeSnapshotStoreConformance = (
	name: string,
	factory: SnapshotStoreConformanceFactory,
	options: SnapshotStoreConformanceOptions = {},
): void => {
	const timeout = options.timeout ?? TEST_TIMEOUT;
	const test = conformanceTest<SnapshotStoreConformanceCase>(options.skip, timeout);

	describe(`${name} snapshot store conformance`, () => {
		const pool = options.pool ?? uniquePoolName();
		const listingPool = `${pool}-listing`;
		const unknownPool = `${pool}-unknown`;
		const collection = SnapshotCollection.get(pool);
		const listingCollection = SnapshotCollection.get(listingPool);

		let handle: ConformanceStoreHandle<ConformanceSnapshotStore> | undefined;
		let store: ConformanceSnapshotStore;

		// A stream with a snapshot at every version of REFERENCE_VERSIONS
		const reference = newSnapshotStream();
		let referenceEnvelopes: SnapshotEnvelope<ConformanceLedger>[] = [];

		// The only snapshots in the 'listing' pool: two per ledger stream, one per audit stream
		const ledgerStreams = Array.from({ length: 7 }, () => newSnapshotStream(ConformanceLedger));
		const auditStreams = Array.from({ length: 2 }, () => newSnapshotStream(ConformanceAudit));
		const ledgerIds = ledgerStreams.map(({ aggregateId }) => aggregateId);
		// Ordered like the 'latest' key of the streams, descending
		const ledgerIdsDescending = [...ledgerIds].sort().reverse();

		const readSnapshots = (stream: SnapshotStream, filter: Omit<ISnapshotFilter, 'pool'> = {}) =>
			store.getSnapshots<ConformanceLedger>(stream, { ...filter, pool });
		const readEnvelopes = (stream: SnapshotStream, filter: Omit<ISnapshotFilter, 'pool'> = {}) =>
			store.getEnvelopes<ConformanceLedger>(stream, { ...filter, pool });
		const readLatestOfAggregate = (
			aggregate: typeof ConformanceLedger | typeof ConformanceAudit,
			filter: Omit<ILatestSnapshotFilter, 'pool'> = {},
		) => store.getLastEnvelopesForAggregate<ConformanceLedger>(aggregate, { ...filter, pool: listingPool });

		/**
		 * Asserts the versions that getSnapshots() and getEnvelopes() read from the reference stream, per batch.
		 */
		const expectBatches = async (filter: Omit<ISnapshotFilter, 'pool'>, expected: number[][]) => {
			const snapshotBatches = await collectBatches(readSnapshots(reference, filter));
			const envelopeBatches = await collectBatches(readEnvelopes(reference, filter));

			expect(
				snapshotBatches.map((batch) => batch.map(versionOf)),
				`getSnapshots(${JSON.stringify(filter)})`,
			).toEqual(expected);
			expect(
				envelopeBatches.map((batch) => batch.map(({ metadata }) => metadata.version)),
				`getEnvelopes(${JSON.stringify(filter)})`,
			).toEqual(expected);
		};

		/**
		 * Asserts the versions that getSnapshots() and getEnvelopes() read from the reference stream.
		 */
		const expectVersions = async (filter: Omit<ISnapshotFilter, 'pool'>, expected: number[]) => {
			const snapshots = await drain(readSnapshots(reference, filter));
			const envelopes = await drain(readEnvelopes(reference, filter));

			expect(snapshots.map(versionOf), `getSnapshots(${JSON.stringify(filter)})`).toEqual(expected);
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
					await expect(call(() => store.getLastSnapshot(reference, pool))).resolves.toStrictEqual(snapshotAt(70));
					expect((await drain(readSnapshots(reference))).map(versionOf)).toEqual(REFERENCE_VERSIONS);
					await expect(
						call(() => store.appendSnapshot(newSnapshotStream(), 1, snapshotAt(1), pool)),
					).resolves.toBeInstanceOf(SnapshotEnvelope);
				})(),
				`Store calls ${context}`,
			);

		const readers: [string, () => AsyncGenerator<unknown[]>][] = [
			['getSnapshots', () => readSnapshots(reference, { batch: 1 })],
			['getEnvelopes', () => readEnvelopes(reference, { batch: 1 })],
			['getLastEnvelopesForAggregate', () => readLatestOfAggregate(ConformanceLedger, { batch: 1 })],
			['listCollections', () => store.listCollections({ batch: 1 })],
		];

		beforeAll(async () => {
			handle = await factory();
			store = handle.store;

			await store.ensureCollection(pool);
			await store.ensureCollection(listingPool);

			for (const version of REFERENCE_VERSIONS) {
				referenceEnvelopes.push(await store.appendSnapshot(reference, version, snapshotAt(version), pool));
			}

			for (const stream of ledgerStreams) {
				for (const version of [1, 2]) {
					await store.appendSnapshot(stream, version, snapshotAt(version, { id: stream.aggregateId }), listingPool);
				}
			}
			for (const stream of auditStreams) {
				await store.appendSnapshot(stream, 1, snapshotAt(1, { id: stream.aggregateId }), listingPool);
			}
		}, timeout);

		afterAll(async () => {
			await handle?.cleanup([collection, listingCollection, SnapshotCollection.get(unknownPool)]);
		}, timeout);

		describe('appending and reading', () => {
			test('append-returns-envelope', 'returns an envelope for the appended snapshot', async () => {
				const stream = newSnapshotStream();

				const envelope = await call(() => store.appendSnapshot(stream, 5, snapshotAt(5), pool));

				expect(envelope).toBeInstanceOf(SnapshotEnvelope);
				expect(envelope.payload).toStrictEqual(snapshotAt(5));
				expect(envelope.metadata.aggregateId).toBe(stream.aggregateId);
				expect(envelope.metadata.version).toBe(5);
				expect(typeof envelope.metadata.snapshotId).toBe('string');
				expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			});

			test('latest-snapshot', 'reads the snapshot with the highest version as the last one', async () => {
				const stream = newSnapshotStream();
				const appended: SnapshotEnvelope<ConformanceLedger>[] = [];
				for (const version of [1, 5, 10]) {
					appended.push(await call(() => store.appendSnapshot(stream, version, snapshotAt(version), pool)));
				}

				await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual(snapshotAt(10));

				const last = await call(() => store.getLastEnvelope<ConformanceLedger>(stream, pool));
				expect(last && describeEnvelope(last)).toEqual(describeEnvelope(appended[2]));
			});

			test('no-snapshot', 'reads no last snapshot for a stream without snapshots', async () => {
				await expect(call(() => store.getLastSnapshot(newSnapshotStream(), pool))).resolves.toBeUndefined();
				await expect(call(() => store.getLastEnvelope(newSnapshotStream(), pool))).resolves.toBeUndefined();
			});

			test('get-snapshot-by-version', 'reads every snapshot by its version', async () => {
				for (const [index, version] of REFERENCE_VERSIONS.entries()) {
					await expect(call(() => store.getSnapshot(reference, version, pool))).resolves.toStrictEqual(
						snapshotAt(version),
					);
					expect(
						describeEnvelope(await call(() => store.getEnvelope<ConformanceLedger>(reference, version, pool))),
					).toEqual(describeEnvelope(referenceEnvelopes[index]));
				}
			});

			test('not-found', 'throws a SnapshotNotFoundException for a version or stream without snapshot', async () => {
				await expectRejectionOfClass(
					call(() => store.getSnapshot(reference, 15, pool)),
					SnapshotNotFoundException,
				);
				await expectRejectionOfClass(
					call(() => store.getSnapshot(newSnapshotStream(), 1, pool)),
					SnapshotNotFoundException,
				);
				await expectRejectionOfClass(
					call(() => store.getEnvelope(reference, 15, pool)),
					SnapshotNotFoundException,
				);
				await expectRejectionOfClass(
					call(() => store.getEnvelope(newSnapshotStream(), 1, pool)),
					SnapshotNotFoundException,
				);
			});

			test(
				'envelope-metadata-round-trip',
				'keeps the snapshot id, aggregate id and version of every envelope',
				async () => {
					const stream = newSnapshotStream();
					const first = await call(() => store.appendSnapshot(stream, 1, snapshotAt(1), pool));
					const second = await call(() => store.appendSnapshot(stream, 2, snapshotAt(2), pool));
					const expected = [first, second].map(describeEnvelope);

					expect((await drain(readEnvelopes(stream))).map(describeEnvelope)).toEqual(expected);
					expect(describeEnvelope(await call(() => store.getEnvelope<ConformanceLedger>(stream, 1, pool)))).toEqual(
						expected[0],
					);

					const last = await call(() => store.getLastEnvelope<ConformanceLedger>(stream, pool));
					expect(last && describeEnvelope(last)).toEqual(expected[1]);

					const many = await call(() => store.getManyLastSnapshotEnvelopes<ConformanceLedger>([stream], pool));
					const fromMany = many.get(stream);
					expect(fromMany && describeEnvelope(fromMany)).toEqual(expected[1]);

					for (const envelope of [last, fromMany]) {
						expect(envelope?.metadata.registeredOn).toBeInstanceOf(Date);
						expect(
							Math.abs((envelope?.metadata.registeredOn.getTime() ?? 0) - second.metadata.registeredOn.getTime()),
						).toBeLessThan(1_000);
					}
				},
			);

			test('registered-on-milliseconds', 'keeps registeredOn to the millisecond', async () => {
				const stream = newSnapshotStream();
				const appended = await call(() => store.appendSnapshot(stream, 1, snapshotAt(1), pool));
				const registeredOn = appended.metadata.registeredOn.toISOString();

				const last = await call(() => store.getLastEnvelope<ConformanceLedger>(stream, pool));
				const single = await call(() => store.getEnvelope<ConformanceLedger>(stream, 1, pool));
				const [fromStream] = await drain(readEnvelopes(stream));
				const fromMany = (await call(() => store.getManyLastSnapshotEnvelopes<ConformanceLedger>([stream], pool))).get(
					stream,
				);

				expect(last?.metadata.registeredOn.toISOString()).toBe(registeredOn);
				expect(single.metadata.registeredOn.toISOString()).toBe(registeredOn);
				expect(fromStream.metadata.registeredOn.toISOString()).toBe(registeredOn);
				expect(fromMany?.metadata.registeredOn.toISOString()).toBe(registeredOn);
			});
		});

		describe('read filters', () => {
			test('filter-from-version', 'reads from fromVersion on', async () => {
				await expectVersions({ fromVersion: 10 }, REFERENCE_VERSIONS);
				await expectVersions({ fromVersion: 30 }, versions(30, 70));
				await expectVersions({ fromVersion: 35 }, versions(40, 70));
				await expectVersions({ fromVersion: 70 }, [70]);
			});

			test('filter-backward', 'reads backward', async () => {
				await expectVersions({ direction: StreamReadingDirection.BACKWARD }, [...REFERENCE_VERSIONS].reverse());
				await expectVersions({ direction: StreamReadingDirection.FORWARD }, REFERENCE_VERSIONS);
			});

			test('filter-backward-from-version', 'reads backward down to fromVersion', async () => {
				await expectVersions(
					{ direction: StreamReadingDirection.BACKWARD, fromVersion: 30 },
					versions(30, 70).reverse(),
				);
			});

			test('filter-limit', 'reads at most limit snapshots', async () => {
				await expectVersions({ limit: 1 }, [10]);
				await expectVersions({ limit: 3 }, [10, 20, 30]);
				await expectVersions({ limit: 10 }, REFERENCE_VERSIONS);
				await expectVersions({ limit: 3, direction: StreamReadingDirection.BACKWARD }, [70, 60, 50]);
				await expectVersions({ limit: 2, fromVersion: 30 }, [30, 40]);
				await expectVersions({ limit: 2, fromVersion: 30, direction: StreamReadingDirection.BACKWARD }, [70, 60]);
			});

			test('filter-batch', 'hands out full batches of batch snapshots, and never changes them afterwards', async () => {
				await expectBatches(
					{ batch: 1 },
					REFERENCE_VERSIONS.map((version) => [version]),
				);
				await expectBatches({ batch: 3 }, [[10, 20, 30], [40, 50, 60], [70]]);
				await expectBatches({ batch: 7 }, [REFERENCE_VERSIONS]);
				await expectBatches({ batch: 2, limit: 5 }, [[10, 20], [30, 40], [50]]);
				await expectBatches({ batch: 3, direction: StreamReadingDirection.BACKWARD }, [
					[70, 60, 50],
					[40, 30, 20],
					[10],
				]);
				await expectBatches({}, [REFERENCE_VERSIONS]);
			});

			test('filter-empty-results', 'yields no batch at all when nothing matches', async () => {
				expect(await collectBatches(readSnapshots(newSnapshotStream()))).toEqual([]);
				expect(await collectBatches(readEnvelopes(newSnapshotStream()))).toEqual([]);
				expect(await collectBatches(readSnapshots(reference, { fromVersion: 71 }))).toEqual([]);
				expect(await collectBatches(readEnvelopes(reference, { fromVersion: 71 }))).toEqual([]);
			});
		});

		describe('bulk reads', () => {
			test('last-snapshots-bulk', 'reads the last snapshot of several streams at once', async () => {
				const streams = [newSnapshotStream(), newSnapshotStream(), newSnapshotStream()];
				const appended: SnapshotEnvelope<ConformanceLedger>[] = [];
				for (const [index, stream] of streams.entries()) {
					for (let version = 1; version <= index + 1; version++) {
						const envelope = await call(() =>
							store.appendSnapshot<ConformanceLedger>(stream, version, snapshotAt(version, { stream: index }), pool),
						);
						if (version === index + 1) {
							appended.push(envelope);
						}
					}
				}
				const withoutSnapshots = newSnapshotStream();
				const requested = [...streams, withoutSnapshots];

				const snapshots = await call(() => store.getLastSnapshots<ConformanceLedger>(requested, pool));
				expect(snapshots.size).toBe(3);
				expect(snapshots.has(withoutSnapshots)).toBe(false);
				for (const [index, stream] of streams.entries()) {
					expect(snapshots.get(stream)).toStrictEqual(snapshotAt(index + 1, { stream: index }));
				}

				const envelopes = await call(() => store.getManyLastSnapshotEnvelopes<ConformanceLedger>(requested, pool));
				expect(envelopes.size).toBe(3);
				expect(envelopes.has(withoutSnapshots)).toBe(false);
				for (const [index, stream] of streams.entries()) {
					const envelope = envelopes.get(stream);
					expect(envelope && describeEnvelope(envelope)).toEqual(describeEnvelope(appended[index]));
				}
			});

			test('last-snapshots-empty-input', 'reads nothing for an empty list of streams', async () => {
				const snapshots = await call(() => store.getLastSnapshots([], pool));
				const envelopes = await call(() => store.getManyLastSnapshotEnvelopes([], pool));

				expect(snapshots.size).toBe(0);
				expect(envelopes.size).toBe(0);
			});

			test(
				'last-snapshots-many-streams',
				`reads the last snapshot of ${MANY_STREAMS} streams at once`,
				async () => {
					const streams = Array.from({ length: MANY_STREAMS }, () => newSnapshotStream());
					for (let index = 0; index < streams.length; index += 10) {
						await Promise.all(
							streams
								.slice(index, index + 10)
								.map((stream) =>
									call(() => store.appendSnapshot(stream, 3, snapshotAt(3, { id: stream.aggregateId }), pool)),
								),
						);
					}

					const snapshots = await call(() => store.getLastSnapshots<ConformanceLedger>(streams, pool));
					const envelopes = await call(() => store.getManyLastSnapshotEnvelopes<ConformanceLedger>(streams, pool));

					expect(snapshots.size).toBe(MANY_STREAMS);
					expect(envelopes.size).toBe(MANY_STREAMS);
					for (const stream of streams) {
						expect(snapshots.get(stream)).toStrictEqual(snapshotAt(3, { id: stream.aggregateId }));
						expect(envelopes.get(stream)?.metadata.aggregateId).toBe(stream.aggregateId);
					}
				},
				timeout * 2,
			);
		});

		describe('optimistic concurrency', () => {
			test(
				'conflict-stale-version',
				'rejects a snapshot at or below the last version with a SnapshotStoreVersionConflictException',
				async () => {
					const stream = newSnapshotStream();
					await call(() => store.appendSnapshot(stream, 10, snapshotAt(10), pool));

					for (const version of [10, 5, 1]) {
						await expectRejectionOfClass(
							call(() => store.appendSnapshot(stream, version, snapshotAt(version, { stale: true }), pool)),
							SnapshotStoreVersionConflictException,
							`Expected to append version ${version}, but latest is 10`,
						);
					}

					// Nothing was written
					await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual(snapshotAt(10));
					expect((await drain(readSnapshots(stream))).map(versionOf)).toEqual([10]);
					await expectRejectionOfClass(
						call(() => store.getSnapshot(stream, 5, pool)),
						SnapshotNotFoundException,
					);

					// A later version is still accepted
					await call(() => store.appendSnapshot(stream, 11, snapshotAt(11), pool));
					await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual(snapshotAt(11));
				},
			);

			for (const seeded of [false, true]) {
				test(
					'conflict-concurrent-appends',
					`lets exactly one of ${CONCURRENT_WRITERS} concurrent appends of the same version to ${seeded ? 'an existing' : 'a new'} stream win`,
					async () => {
						const stream = newSnapshotStream();
						if (seeded) {
							await call(() => store.appendSnapshot(stream, 1, snapshotAt(1), pool));
						}

						const results = await withinTimeout(
							Promise.allSettled(
								Array.from({ length: CONCURRENT_WRITERS }, (_, writer) =>
									call(() => store.appendSnapshot(stream, 2, snapshotAt(2, { writer }), pool)),
								),
							),
							'Concurrent appends',
						);

						const winners = results.flatMap((result, writer) => (result.status === 'fulfilled' ? [writer] : []));
						expect(winners, 'the number of appends that succeeded').toHaveLength(1);
						// Every other append lost the race with a version conflict
						const otherFailures = results.flatMap((result) =>
							result.status === 'rejected' && result.reason?.constructor !== SnapshotStoreVersionConflictException
								? [String(result.reason)]
								: [],
						);
						expect(otherFailures).toEqual([]);

						const winner = snapshotAt(2, { writer: winners[0] });
						await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual(winner);
						expect((await drain(readSnapshots(stream))).map(versionOf)).toEqual(seeded ? [1, 2] : [2]);
						const lastSnapshots = await call(() => store.getLastSnapshots<ConformanceLedger>([stream], pool));
						expect([...lastSnapshots.values()]).toStrictEqual([winner]);
					},
				);
			}
		});

		describe('latest snapshots of an aggregate', () => {
			test(
				'aggregate-latest-only',
				'reads the last snapshot of every stream of the aggregate, and nothing else',
				async () => {
					const envelopes = await drain(readLatestOfAggregate(ConformanceLedger));

					expect(envelopes.map(({ metadata }) => metadata.aggregateId).sort()).toEqual([...ledgerIds].sort());
					for (const { payload, metadata } of envelopes) {
						expect(metadata.version).toBe(2);
						expect(payload).toStrictEqual(snapshotAt(2, { id: metadata.aggregateId }));
					}

					const audits = await drain(readLatestOfAggregate(ConformanceAudit));
					expect(audits.map(({ metadata }) => metadata.aggregateId).sort()).toEqual(
						auditStreams.map(({ aggregateId }) => aggregateId).sort(),
					);
				},
			);

			test('aggregate-limit', 'reads at most limit snapshots', async () => {
				const limited = await drain(readLatestOfAggregate(ConformanceLedger, { limit: 3 }));
				expect(limited).toHaveLength(3);
				expect(new Set(limited.map(({ metadata }) => metadata.aggregateId)).size).toBe(3);

				expect(await drain(readLatestOfAggregate(ConformanceLedger, { limit: 10 }))).toHaveLength(7);
			});

			test('aggregate-batch', 'hands out full batches of batch snapshots', async () => {
				const batches = await collectBatches(readLatestOfAggregate(ConformanceLedger, { batch: 3 }));
				expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
				expect(new Set(batches.flat().map(({ metadata }) => metadata.aggregateId)).size).toBe(7);

				const limited = await collectBatches(readLatestOfAggregate(ConformanceLedger, { batch: 3, limit: 5 }));
				expect(limited.map((batch) => batch.length)).toEqual([3, 2]);
			});

			test('aggregate-order', 'reads the streams in descending order of their id', async () => {
				const envelopes = await drain(readLatestOfAggregate(ConformanceLedger));
				expect(envelopes.map(({ metadata }) => metadata.aggregateId)).toEqual(ledgerIdsDescending);

				const limited = await drain(readLatestOfAggregate(ConformanceLedger, { limit: 3 }));
				expect(limited.map(({ metadata }) => metadata.aggregateId)).toEqual(ledgerIdsDescending.slice(0, 3));
			});

			test(
				'aggregate-cursor-paging',
				'pages through the streams with the aggregateId of the last snapshot as an exclusive cursor',
				async () => {
					const pages: string[][] = [];
					let cursor: string | undefined;
					for (let page = 0; page <= ledgerIds.length; page++) {
						const envelopes = await drain(readLatestOfAggregate(ConformanceLedger, { limit: 3, aggregateId: cursor }));
						if (envelopes.length === 0) {
							break;
						}
						pages.push(envelopes.map(({ metadata }) => metadata.aggregateId));
						cursor = envelopes[envelopes.length - 1].metadata.aggregateId;
					}

					// Disjoint pages that together hold every stream once
					expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
					expect(pages.flat()).toEqual(ledgerIdsDescending);
				},
			);
		});

		describe('pools', () => {
			test(
				'unknown-pool-append',
				'rejects a snapshot for a pool whose collection was never created, without creating it',
				async () => {
					await expectRejectionOfClass(
						call(() => store.appendSnapshot(newSnapshotStream(), 1, snapshotAt(1), unknownPool)),
						SnapshotStorePersistenceException,
					);
					expect(await drain(store.listCollections())).not.toContain(SnapshotCollection.get(unknownPool));
				},
			);

			test('unknown-pool-read', 'rejects reads from a pool whose collection was never created', async () => {
				const filter = { pool: unknownPool };
				await expectRejection(drain(store.getSnapshots(reference, filter)), 'getSnapshots()');
				await expectRejection(drain(store.getEnvelopes(reference, filter)), 'getEnvelopes()');
				await expectRejection(
					call(() => store.getSnapshot(reference, 10, unknownPool)),
					'getSnapshot()',
				);
				await expectRejection(
					call(() => store.getEnvelope(reference, 10, unknownPool)),
					'getEnvelope()',
				);
				await expectRejection(
					call(() => store.getLastSnapshot(reference, unknownPool)),
					'getLastSnapshot()',
				);
				await expectRejection(
					call(() => store.getLastEnvelope(reference, unknownPool)),
					'getLastEnvelope()',
				);
				await expectRejection(
					call(() => store.getLastSnapshots([reference], unknownPool)),
					'getLastSnapshots()',
				);
				await expectRejection(
					call(() => store.getManyLastSnapshotEnvelopes([reference], unknownPool)),
					'getManyLastSnapshotEnvelopes()',
				);
				await expectRejection(
					drain(store.getLastEnvelopesForAggregate(ConformanceLedger, filter)),
					'getLastEnvelopesForAggregate()',
				);
			});

			test(
				'ensure-collection-idempotent',
				'ensures an existing collection without touching its snapshots',
				async () => {
					await expect(call(() => store.ensureCollection(pool))).resolves.toBe(collection);
					await expect(call(() => store.ensureCollection(pool))).resolves.toBe(collection);

					expect((await drain(readEnvelopes(reference))).map(describeEnvelope)).toEqual(
						referenceEnvelopes.map(describeEnvelope),
					);
					await expect(call(() => store.getLastSnapshot(reference, pool))).resolves.toStrictEqual(snapshotAt(70));
				},
			);

			test('list-collections', 'lists the collections of the pools, in batches of at most batch', async () => {
				const batches = await collectBatches(store.listCollections({ batch: 1 }));
				for (const batch of batches) {
					expect(batch).toHaveLength(1);
				}

				const collections = batches.flat();
				expect(collections).toContain(collection);
				expect(collections).toContain(listingCollection);
				expect(new Set(collections).size).toBe(collections.length);

				expect(await drain(store.listCollections())).toEqual(expect.arrayContaining([collection, listingCollection]));
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

			test('nested-calls-during-iteration', 'serves other calls while a read is in progress', async () => {
				const stream = newSnapshotStream();
				const read: number[] = [];

				await withinTimeout(
					(async () => {
						for await (const batch of readSnapshots(reference, { batch: 1 })) {
							read.push(...batch.map(versionOf));

							await expect(call(() => store.getLastSnapshot(reference, pool))).resolves.toStrictEqual(snapshotAt(70));
							expect((await drain(readEnvelopes(reference, { fromVersion: 70 }))).map(describeEnvelope)).toEqual([
								describeEnvelope(referenceEnvelopes[6]),
							]);
							await call(() => store.appendSnapshot(stream, read.length, snapshotAt(read.length), pool));
						}
					})(),
					'Store calls made while reading',
					CALL_TIMEOUT * 2,
				);

				expect(read).toEqual(REFERENCE_VERSIONS);
				await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual(snapshotAt(7));
			});
		});

		describe('payloads', () => {
			test('payload-json-fidelity', 'returns JSON payloads exactly as they were appended', async () => {
				const stream = newSnapshotStream();
				const snapshot: ConformanceSnapshot = { state: createJsonPayloadProbe() };

				await call(() => store.appendSnapshot(stream, 1, snapshot, pool));

				await expect(call(() => store.getSnapshot(stream, 1, pool))).resolves.toStrictEqual(snapshot);
				await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual(snapshot);
				expect(await drain(readSnapshots(stream))).toStrictEqual([snapshot]);
				expect((await call(() => store.getEnvelope(stream, 1, pool))).payload).toStrictEqual(snapshot);
				expect((await call(() => store.getLastEnvelope(stream, pool)))?.payload).toStrictEqual(snapshot);
				expect((await drain(readEnvelopes(stream)))[0].payload).toStrictEqual(snapshot);
				expect((await call(() => store.getLastSnapshots([stream], pool))).get(stream)).toStrictEqual(snapshot);
				expect(
					(await call(() => store.getManyLastSnapshotEnvelopes([stream], pool))).get(stream)?.payload,
				).toStrictEqual(snapshot);
			});

			test('payload-dates-as-iso-strings', 'returns dates in payloads as ISO-8601 strings', async () => {
				const stream = newSnapshotStream();
				const { payload, expected } = createDatePayloadProbe();

				await call(() => store.appendSnapshot(stream, 1, { state: payload }, pool));

				await expect(call(() => store.getSnapshot(stream, 1, pool))).resolves.toStrictEqual({ state: expected });
				await expect(call(() => store.getLastSnapshot(stream, pool))).resolves.toStrictEqual({ state: expected });
				expect((await call(() => store.getEnvelope(stream, 1, pool))).payload).toStrictEqual({ state: expected });
				expect((await drain(readSnapshots(stream)))[0]).toStrictEqual({ state: expected });
			});
		});
	});
};
