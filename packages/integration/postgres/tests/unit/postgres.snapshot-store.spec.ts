import { randomInt } from 'node:crypto';
import {
	Aggregate,
	AggregateRoot,
	type ISnapshot,
	type ISnapshotCollection,
	SnapshotCollection,
	type SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
	StreamReadingDirection,
	UUID,
} from '@ocoda/event-sourcing';
import { type PostgresSnapshotEntity, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import {
	Account,
	AccountId,
	customerSnapshot,
	snapshotEnvelopesAccountA,
	snapshotEnvelopesAccountB,
	snapshotStreamAccountA,
	snapshotStreamAccountB,
	snapshotStreamCustomer,
	snapshotsAccountA,
	snapshotsAccountB,
} from '@ocoda/event-sourcing-testing/unit';
import { Client, type Pool, escapeIdentifier } from 'pg';

const connectionOptions = {
	host: '127.0.0.1',
	port: 5432,
	user: 'postgres',
	password: 'postgres',
	database: 'postgres',
	application_name: 'postgres-snapshot-store-spec',
};

describe(PostgresSnapshotStore, () => {
	let snapshotStore: PostgresSnapshotStore;
	const envelopesAccountA = snapshotEnvelopesAccountA;
	const envelopesAccountB = snapshotEnvelopesAccountB;

	let pool: Pool;

	beforeAll(async () => {
		snapshotStore = new PostgresSnapshotStore({ driver: undefined as never, ...connectionOptions });

		await snapshotStore.connect();
		await snapshotStore.ensureCollection();

		pool = snapshotStore['pool'];
	});

	afterAll(async () => {
		await Promise.all([
			pool.query(`DROP TABLE IF EXISTS "${SnapshotCollection.get()}"`),
			pool.query(`DROP TABLE IF EXISTS "${SnapshotCollection.get('a')}"`),
			pool.query(`DROP TABLE IF EXISTS "${SnapshotCollection.get('b')}"`),
			pool.query(`DROP TABLE IF EXISTS "${SnapshotCollection.get('c')}"`),
		]);
		await snapshotStore.disconnect();
	});

	it('should append snapshot envelopes', async () => {
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 1, snapshotsAccountA[0]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 1, snapshotsAccountB[0]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 10, snapshotsAccountA[1]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 10, snapshotsAccountB[1]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 20, snapshotsAccountA[2]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 20, snapshotsAccountB[2]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 30, snapshotsAccountA[3]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 30, snapshotsAccountB[3]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 40, snapshotsAccountA[4]);
		await snapshotStore.appendSnapshot(snapshotStreamCustomer, 1, customerSnapshot);
		await snapshotStore.appendSnapshot(snapshotStreamCustomer, 10, customerSnapshot);

		const { rows: entities } = await pool.query<PostgresSnapshotEntity<Account>>(`
            SELECT * FROM "${SnapshotCollection.get()}" ORDER BY version ASC
        `);

		const entitiesAccountA = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === snapshotStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === snapshotStreamAccountB.streamId,
		);
		const entitiesCustomer = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === snapshotStreamCustomer.streamId,
		);
		expect(entitiesAccountA).toHaveLength(snapshotsAccountA.length);
		expect(entitiesAccountB).toHaveLength(snapshotsAccountB.length);
		expect(entitiesCustomer).toHaveLength(2);
		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.stream_id).toEqual(snapshotStreamAccountA.streamId);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregate_id).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(entity.registered_on).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);

			if (index === entitiesAccountA.length - 1) {
				expect(entity.latest).toEqual(`latest#${snapshotStreamAccountA.streamId}`);
			} else {
				expect(entity.latest).toBeNull();
			}
		}
	});

	it('should throw when trying to append a snapshot to a stream that has a version lower or equal to the latest snapshot for that stream', async () => {
		const lastSnapshotEnvelope = snapshotEnvelopesAccountA[snapshotEnvelopesAccountA.length - 1];
		const lastVersion = lastSnapshotEnvelope.metadata.version;
		const beforeLastVersion = lastVersion - 10;
		await expect(
			snapshotStore.appendSnapshot(snapshotStreamAccountA, beforeLastVersion, lastSnapshotEnvelope),
		).rejects.toThrow(
			new SnapshotStoreVersionConflictException(snapshotStreamAccountA, beforeLastVersion, lastVersion),
		);
		await expect(
			snapshotStore.appendSnapshot(snapshotStreamAccountA, lastVersion, lastSnapshotEnvelope),
		).rejects.toThrow(new SnapshotStoreVersionConflictException(snapshotStreamAccountA, lastVersion, lastVersion));
	});

	it("should throw when a snapshot envelope can't be appended", async () => {
		await expect(
			snapshotStore.appendSnapshot(snapshotStreamAccountA, 1, snapshotsAccountA[0], 'not-a-pool'),
		).rejects.toThrow(SnapshotStorePersistenceException);
	});

	it('should retrieve a single snapshot from a specified stream', async () => {
		const resolvedSnapshot = await snapshotStore.getSnapshot(
			snapshotStreamAccountA,
			envelopesAccountA[1].metadata.version,
		);
		expect(resolvedSnapshot).toEqual(snapshotsAccountA[1]);
	});

	it('should retrieve snapshots by stream', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA)) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA);
	});

	it('should filter snapshots by stream and version', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			fromVersion: 30,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(3));
	});

	it("should throw when a snapshot isn't found in a specified stream", async () => {
		const stream = SnapshotStream.for(Account, AccountId.generate());
		await expect(snapshotStore.getSnapshot(stream, 20)).rejects.toThrow(
			new SnapshotNotFoundException(stream.streamId, 20),
		);
	});

	it('should retrieve snapshots backwards', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice().reverse());
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			fromVersion: envelopesAccountA[1].metadata.version,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(
			snapshotsAccountA.filter((_, index) => (index + 1) * 10 >= envelopesAccountA[2].metadata.version).reverse(),
		);
	});

	it('should limit the returned snapshots', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { limit: 2 })) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(0, 2));
	});

	it('should batch the returned snapshots', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { limit: 2 })) {
			expect(snapshots.length).toBe(2);
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(0, 2));
	});

	it('should retrieve the last snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStreamAccountA);
		expect(resolvedSnapshot).toEqual(snapshotsAccountA[snapshotsAccountA.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, UUID.generate()));
		expect(resolvedSnapshot).toBeUndefined();
	});

	it('should retrieve multiple last snapshots', async () => {
		const resolvedSnapshots = await snapshotStore.getLastSnapshots([snapshotStreamAccountA, snapshotStreamAccountB]);

		expect(resolvedSnapshots.size).toBe(2);
		expect(resolvedSnapshots.get(snapshotStreamAccountA)).toEqual(snapshotsAccountA[snapshotsAccountA.length - 1]);
		expect(resolvedSnapshots.get(snapshotStreamAccountB)).toEqual(snapshotsAccountB[snapshotsAccountB.length - 1]);
	});

	it('should retrieve snapshot-envelopes', async () => {
		const resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getEnvelopes(snapshotStreamAccountA)) {
			resolvedEnvelopes.push(...envelopes);
		}
		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);
		for (const [index, envelope] of resolvedEnvelopes.entries()) {
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
		}
	});

	it('should retrieve a single snapshot-envelope', async () => {
		const { metadata, payload } = await snapshotStore.getEnvelope(
			snapshotStreamAccountA,
			envelopesAccountA[3].metadata.version,
		);
		expect(payload).toEqual(envelopesAccountA[3].payload);
		expect(metadata.aggregateId).toEqual(envelopesAccountA[3].metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopesAccountA[3].metadata.version);
	});

	it('should retrieve the last snapshot-envelope', async () => {
		const lastEnvelope = envelopesAccountA[envelopesAccountA.length - 1];
		const snapshotEnvelope = await snapshotStore.getLastEnvelope(snapshotStreamAccountA);

		if (!snapshotEnvelope) {
			throw new Error('Snapshot envelope not found');
		}

		const { metadata, payload } = snapshotEnvelope;

		expect(payload).toEqual(lastEnvelope.payload);
		expect(metadata.aggregateId).toEqual(lastEnvelope.metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(lastEnvelope.metadata.version);
	});

	it('should retrieve the last snapshot-envelopes for an aggregate', async () => {
		let resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Account)) {
			resolvedEnvelopes.push(...envelopes);
		}
		expect(resolvedEnvelopes).toHaveLength(2);
		const [envelopeAccountB, envelopeAccountA] = [
			envelopesAccountB[envelopesAccountB.length - 1],
			envelopesAccountA[envelopesAccountA.length - 1],
		];
		resolvedEnvelopes = resolvedEnvelopes.sort((a, b) => (a.metadata.version > b.metadata.version ? 1 : -1));
		expect(resolvedEnvelopes[0].payload).toEqual(envelopeAccountB.payload);
		expect(resolvedEnvelopes[0].metadata.aggregateId).toEqual(envelopeAccountB.metadata.aggregateId);
		expect(resolvedEnvelopes[0].metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedEnvelopes[0].metadata.version).toEqual(envelopeAccountB.metadata.version);
		expect(resolvedEnvelopes[1].payload).toEqual(envelopeAccountA.payload);
		expect(resolvedEnvelopes[1].metadata.aggregateId).toEqual(envelopeAccountA.metadata.aggregateId);
		expect(resolvedEnvelopes[1].metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedEnvelopes[1].metadata.version).toEqual(envelopeAccountA.metadata.version);
	});

	it('should filter the last snapshot-envelopes by streamId', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		class FooId extends UUID {}

		const fooIds = Array.from({ length: 20 })
			.map(() => FooId.generate())
			.sort();
		for await (const id of fooIds) {
			await snapshotStore.appendSnapshot(SnapshotStream.for(Foo, id), randomInt(1, 10) * 10, {
				balance: randomInt(1000),
			});
		}

		const fetchedAccountIds: Set<string> = new Set();
		const firstPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, { limit: 15 })) {
			firstPageEnvelopes.push(...envelopes);
		}

		expect(firstPageEnvelopes).toHaveLength(15);
		for (const { metadata } of firstPageEnvelopes) {
			fetchedAccountIds.add(metadata.aggregateId);
		}

		const lastPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, {
			limit: 5,
			aggregateId: firstPageEnvelopes[14].metadata.aggregateId,
		})) {
			lastPageEnvelopes.push(...envelopes);
		}

		expect(lastPageEnvelopes).toHaveLength(5);
		for (const { metadata } of lastPageEnvelopes) {
			fetchedAccountIds.add(metadata.aggregateId);
		}

		expect(fooIds).toHaveLength(20);
	});

	it('should retrieve multiple last snapshot-envelopes for given streams', async () => {
		const resolvedSnapshots = await snapshotStore.getManyLastSnapshotEnvelopes([
			snapshotStreamAccountA,
			snapshotStreamAccountB,
		]);

		expect(resolvedSnapshots.size).toBe(2);

		const [envelopeAccountA, envelopeAccountB] = [
			envelopesAccountA[envelopesAccountA.length - 1],
			envelopesAccountB[envelopesAccountB.length - 1],
		];

		const resolvedAccountAEnvelope = resolvedSnapshots.get(snapshotStreamAccountA);
		const resolvedAccountBEnvelope = resolvedSnapshots.get(snapshotStreamAccountB);

		if (!resolvedAccountAEnvelope || !resolvedAccountBEnvelope) {
			throw new Error('Snapshot envelope not found');
		}

		expect(resolvedAccountAEnvelope.payload).toEqual(envelopeAccountA.payload);
		expect(resolvedAccountAEnvelope.metadata.aggregateId).toEqual(envelopeAccountA.metadata.aggregateId);
		expect(resolvedAccountAEnvelope.metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedAccountAEnvelope.metadata.version).toEqual(envelopeAccountA.metadata.version);

		expect(resolvedAccountBEnvelope.payload).toEqual(envelopeAccountB.payload);
		expect(resolvedAccountBEnvelope.metadata.aggregateId).toEqual(envelopeAccountB.metadata.aggregateId);
		expect(resolvedAccountBEnvelope.metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedAccountBEnvelope.metadata.version).toEqual(envelopeAccountB.metadata.version);
	});

	it('should list collections', async () => {
		await Promise.all([
			snapshotStore.ensureCollection('a'),
			snapshotStore.ensureCollection('b'),
			snapshotStore.ensureCollection('c'),
		]);

		const resolvedCollections: ISnapshotCollection[] = [];
		for await (const collections of snapshotStore.listCollections()) {
			resolvedCollections.push(...collections);
		}

		expect(resolvedCollections.includes('a-snapshots')).toBe(true);
		expect(resolvedCollections.includes('b-snapshots')).toBe(true);
		expect(resolvedCollections.includes('c-snapshots')).toBe(true);
	});

	describe('lifecycle', () => {
		afterEach(() => jest.restoreAllMocks());

		it('should fail to connect when the database is unreachable', async () => {
			const unreachableStore = new PostgresSnapshotStore({ driver: undefined as never, ...connectionOptions, port: 1 });

			await expect(unreachableStore.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
			await unreachableStore.disconnect();
		});

		it('should discard idle connections that fail instead of crashing', async () => {
			const error = jest.spyOn(snapshotStore['logger'], 'error').mockImplementation(() => undefined);

			// Make sure the pool holds more than the connection that terminates the others
			await Promise.all([pool.query('SELECT pg_sleep(0.05)'), pool.query('SELECT pg_sleep(0.05)')]);
			const { rows } = await pool.query<{ terminated: boolean }>(
				`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
				WHERE application_name = $1 AND state = 'idle' AND pid <> pg_backend_pid()`,
				[connectionOptions.application_name],
			);
			expect(rows.length).toBeGreaterThan(0);

			for (let attempt = 0; attempt < 100 && error.mock.calls.length < rows.length; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(error).toHaveBeenCalledTimes(rows.length);
			expect(error).toHaveBeenCalledWith(
				'Idle database connection failed: terminating connection due to administrator command',
			);
			await expect(
				snapshotStore.getLastSnapshot(SnapshotStream.for(Account, AccountId.generate())),
			).resolves.toBeUndefined();
		});
	});

	/**
	 * Resolves the definitions of all indexes on a table in the current schema.
	 */
	const getIndexDefinitions = async (table: string): Promise<string[]> => {
		const { rows } = await pool.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes
			WHERE schemaname = current_schema() AND tablename = $1
			ORDER BY indexname COLLATE "C"`,
			[table],
		);
		return rows.map(({ indexdef }) => indexdef);
	};

	/**
	 * Waits until a session is blocked on a lock while inserting into the given table and returns its process id.
	 */
	const waitForBlockedInsert = async (table: string): Promise<number> => {
		for (let attempt = 0; attempt < 250; attempt++) {
			const { rows } = await pool.query<{ pid: number }>(
				`SELECT pid FROM pg_stat_activity
				WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
				[`%INSERT INTO ${escapeIdentifier(table)}%`],
			);
			if (rows.length > 0) {
				return rows[0].pid;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`No insert into ${table} is waiting for a lock`);
	};

	/**
	 * Rejects when the given promise doesn't settle in time, so a starved connection pool fails a test instead of hanging it.
	 */
	const withinTimeout = <T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> => {
		let timer: NodeJS.Timeout;
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
			}),
		]).finally(() => clearTimeout(timer));
	};

	/**
	 * Resolves the versions of the snapshots of a stream, and which of them is flagged as the latest.
	 */
	const getStoredVersions = async (collection: string, { streamId }: SnapshotStream) => {
		const { rows } = await pool.query<{ version: number; latest: string | null }>(
			`SELECT version, latest FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 ORDER BY version`,
			[streamId],
		);
		return {
			versions: rows.map(({ version }) => version),
			latest: rows.filter(({ latest }) => latest === `latest#${streamId}`).map(({ version }) => version),
		};
	};

	describe('connection handling', () => {
		const connectionPool = 'postgres-connection';
		const streamX = SnapshotStream.for(Account, AccountId.generate());
		const streamY = SnapshotStream.for(Account, AccountId.generate());
		const snapshots: ISnapshot<Account>[] = [{ balance: 10 }, { balance: 20 }, { balance: 30 }];
		// More iterations than the default pg pool size (10), so a leaked connection would exhaust the pool.
		const iterations = 15;

		const readers: Array<[string, () => AsyncGenerator<unknown[]>]> = [
			['getSnapshots', () => snapshotStore.getSnapshots(streamX, { pool: connectionPool, batch: 1 })],
			['getEnvelopes', () => snapshotStore.getEnvelopes(streamX, { pool: connectionPool, batch: 1 })],
			[
				'getLastEnvelopesForAggregate',
				() => snapshotStore.getLastEnvelopesForAggregate(Account, { pool: connectionPool, batch: 1 }),
			],
			['listCollections', () => snapshotStore.listCollections({ batch: 1 })],
		];

		const expectStoreToBeUsable = async () => {
			await expect(snapshotStore.getSnapshot(streamY, 20, connectionPool)).resolves.toEqual(snapshots[1]);
			await expect(snapshotStore.getLastSnapshot(streamY, connectionPool)).resolves.toEqual(snapshots[2]);

			const resolvedSnapshots: ISnapshot<Account>[] = [];
			for await (const batch of snapshotStore.getSnapshots(streamY, { pool: connectionPool })) {
				resolvedSnapshots.push(...batch);
			}
			expect(resolvedSnapshots).toEqual(snapshots);

			// Every connection has been handed back to the pool
			expect(pool.idleCount).toBe(pool.totalCount);
			expect(pool.waitingCount).toBe(0);
		};

		beforeAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(SnapshotCollection.get(connectionPool))}`);
			await snapshotStore.ensureCollection(connectionPool);
			for (const [index, snapshot] of snapshots.entries()) {
				await snapshotStore.appendSnapshot(streamX, (index + 1) * 10, snapshot, connectionPool);
				await snapshotStore.appendSnapshot(streamY, (index + 1) * 10, snapshot, connectionPool);
			}
		});

		afterAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(SnapshotCollection.get(connectionPool))}`);
		});

		it.each(readers)(
			'should release the connection when a %s loop is exited early',
			async (_, read) => {
				for (let iteration = 0; iteration < iterations; iteration++) {
					let batches = 0;
					for await (const batch of read()) {
						expect(batch).toHaveLength(1);
						batches++;
						break;
					}
					expect(batches).toBe(1);
				}

				await expectStoreToBeUsable();
			},
			15_000,
		);

		it.each(readers)(
			'should release the connection when the consumer of a %s loop throws',
			async (_, read) => {
				for (let iteration = 0; iteration < iterations; iteration++) {
					await expect(
						(async () => {
							for await (const _batch of read()) {
								throw new Error('consumer failure');
							}
						})(),
					).rejects.toThrow('consumer failure');
				}

				await expectStoreToBeUsable();
			},
			15_000,
		);

		it('should release the connection when a query fails while iterating', async () => {
			for (let iteration = 0; iteration < iterations; iteration++) {
				await expect(
					(async () => {
						for await (const _batch of snapshotStore.getSnapshots(streamX, { pool: 'postgres-missing' })) {
							// the collection doesn't exist, so no batch is ever yielded
						}
					})(),
				).rejects.toThrow('relation "postgres-missing-snapshots" does not exist');
			}

			await expectStoreToBeUsable();
		}, 15_000);

		it('should allow store calls while iterating', async () => {
			const streamCopy = SnapshotStream.for(Account, AccountId.generate());

			for await (const envelopes of snapshotStore.getEnvelopes(streamX, { pool: connectionPool, batch: 1 })) {
				for (const envelope of envelopes) {
					const { version } = envelope.metadata;

					await expect(snapshotStore.getSnapshot(streamX, version, connectionPool)).resolves.toEqual(envelope.payload);
					await expect(snapshotStore.getLastSnapshot(streamY, connectionPool)).resolves.toEqual(snapshots[2]);

					const nestedSnapshots: ISnapshot<Account>[] = [];
					for await (const batch of snapshotStore.getSnapshots(streamY, {
						pool: connectionPool,
						fromVersion: version,
						limit: 1,
					})) {
						nestedSnapshots.push(...batch);
					}
					expect(nestedSnapshots).toEqual([envelope.payload]);

					await snapshotStore.appendSnapshot(streamCopy, version, envelope.payload, connectionPool);
				}
			}

			const copiedSnapshots: ISnapshot<Account>[] = [];
			for await (const batch of snapshotStore.getSnapshots(streamCopy, { pool: connectionPool })) {
				copiedSnapshots.push(...batch);
			}
			expect(copiedSnapshots).toEqual(snapshots);
			await expectStoreToBeUsable();
		}, 15_000);

		describe('with more readers than connections', () => {
			let smallStore: PostgresSnapshotStore;
			let smallPool: Pool;

			beforeEach(async () => {
				smallStore = new PostgresSnapshotStore({ driver: undefined as never, ...connectionOptions, max: 2 });
				await smallStore.connect();
				smallPool = smallStore['pool'];
			});

			afterEach(async () => {
				// A leaked connection keeps the pool from ending
				await withinTimeout(smallStore.disconnect()).catch(() => undefined);
			});

			it('should not hold a connection while the last batch is consumed', async () => {
				// Every reader calls the store while it holds the last batch, which needs a connection of its own
				await withinTimeout(
					Promise.all(
						Array.from({ length: 6 }, async () => {
							const resolvedSnapshots: ISnapshot<Account>[] = [];
							for await (const batch of smallStore.getSnapshots(streamY, { pool: connectionPool })) {
								resolvedSnapshots.push(...batch);
								await expect(smallStore.getLastSnapshot(streamY, connectionPool)).resolves.toEqual(snapshots[2]);
							}
							expect(resolvedSnapshots).toEqual(snapshots);
						}),
					),
				);

				expect(smallPool.idleCount).toBe(smallPool.totalCount);
			}, 15_000);

			it.each<[string, (store: PostgresSnapshotStore) => AsyncGenerator<unknown[]>]>([
				['getSnapshots', (store) => store.getSnapshots(streamY, { pool: connectionPool })],
				['getEnvelopes', (store) => store.getEnvelopes(streamY, { pool: connectionPool })],
				[
					'getLastEnvelopesForAggregate',
					(store) => store.getLastEnvelopesForAggregate(Account, { pool: connectionPool }),
				],
				['listCollections', (store) => store.listCollections({ batch: 1_000 })],
			])(
				'should not hold a connection when a %s read that fits in one batch is never finished',
				async (_, read) => {
					for (let reader = 0; reader < 6; reader++) {
						const { done, value } = await withinTimeout(read(smallStore).next());
						expect(done).toBe(false);
						expect(value.length).toBeGreaterThan(0);
					}

					await expect(withinTimeout(smallStore.getLastSnapshot(streamY, connectionPool))).resolves.toEqual(
						snapshots[2],
					);
					expect(smallPool.idleCount).toBe(smallPool.totalCount);
				},
				15_000,
			);
		});
	});

	describe('appending', () => {
		const appendPool = 'postgres-append';
		const appendCollection = SnapshotCollection.get(appendPool);

		beforeAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(appendCollection)}`);
			await snapshotStore.ensureCollection(appendPool);
		});

		afterAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(appendCollection)}`);
		});

		it('should keep the previous snapshot flagged as latest when appending a snapshot fails', async () => {
			const stream = SnapshotStream.for(Account, AccountId.generate());
			await snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, appendPool);

			// Postgres can't store a NUL character in a JSONB value, so the insert fails after the previous snapshot was unflagged
			await expect(snapshotStore.appendSnapshot(stream, 20, { owners: ['\u0000'] }, appendPool)).rejects.toThrow(
				SnapshotStorePersistenceException,
			);

			await expect(snapshotStore.getLastSnapshot(stream, appendPool)).resolves.toEqual({ balance: 10 });
			expect(await getStoredVersions(appendCollection, stream)).toEqual({ versions: [10], latest: [10] });
		});

		it('should let exactly one of several concurrent appends of the same version succeed', async () => {
			for (let round = 0; round < 5; round++) {
				const stream = SnapshotStream.for(Account, AccountId.generate());
				await snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, appendPool);

				const results = await Promise.allSettled(
					Array.from({ length: 8 }, (_, index) =>
						snapshotStore.appendSnapshot(stream, 20, { balance: index }, appendPool),
					),
				);

				const succeeded = results.filter(({ status }) => status === 'fulfilled');
				const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				expect(succeeded).toHaveLength(1);
				expect(failed).toHaveLength(7);
				for (const { reason } of failed) {
					expect(reason).toBeInstanceOf(SnapshotStoreVersionConflictException);
				}
				expect(await getStoredVersions(appendCollection, stream)).toEqual({ versions: [10, 20], latest: [20] });
			}
		}, 15_000);

		it('should flag exactly one snapshot as latest when different versions are appended concurrently', async () => {
			for (let round = 0; round < 5; round++) {
				const stream = SnapshotStream.for(Account, AccountId.generate());
				const versions = [10, 20, 30, 40, 50, 60, 70, 80];

				const results = await Promise.allSettled(
					versions.map((version) => snapshotStore.appendSnapshot(stream, version, { balance: version }, appendPool)),
				);

				const succeeded = results
					.map((result, index) => (result.status === 'fulfilled' ? versions[index] : undefined))
					.filter((version) => version !== undefined);
				const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				for (const { reason } of failed) {
					expect(reason).toBeInstanceOf(SnapshotStoreVersionConflictException);
				}
				expect(await getStoredVersions(appendCollection, stream)).toEqual({ versions: succeeded, latest: [80] });
				await expect(snapshotStore.getLastSnapshot(stream, appendPool)).resolves.toEqual({ balance: 80 });
			}
		}, 15_000);

		it('should unflag every previous snapshot when a stream has several flagged as latest', async () => {
			const stream = SnapshotStream.for(Account, AccountId.generate());
			// Concurrent appends of earlier versions could leave a stream with several snapshots flagged as latest
			for (const version of [10, 20]) {
				await pool.query(
					`INSERT INTO ${escapeIdentifier(appendCollection)} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
					VALUES ($1, $2, '{}', 'legacy', 'legacy', now(), 'account', $3)`,
					[stream.streamId, version, `latest#${stream.streamId}`],
				);
			}

			await expect(snapshotStore.appendSnapshot(stream, 20, { balance: 20 }, appendPool)).rejects.toThrow(
				new SnapshotStoreVersionConflictException(stream, 20, 20),
			);
			await snapshotStore.appendSnapshot(stream, 30, { balance: 30 }, appendPool);

			expect(await getStoredVersions(appendCollection, stream)).toEqual({ versions: [10, 20, 30], latest: [30] });
		});

		it('should report a unique violation during an append as a version conflict', async () => {
			const stream = SnapshotStream.for(Account, AccountId.generate());
			const blocker = new Client(connectionOptions);
			await blocker.connect();

			try {
				// Another writer inserted version 10 but hasn't committed yet, so the version check can't see it.
				await blocker.query('BEGIN');
				await blocker.query(
					`INSERT INTO ${escapeIdentifier(appendCollection)} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
					VALUES ($1, 10, '{}', 'blocker', 'blocker', now(), 'account', $2)`,
					[stream.streamId, `latest#${stream.streamId}`],
				);

				const append = snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, appendPool).then(
					() => undefined,
					(error: Error) => error,
				);

				await waitForBlockedInsert(appendCollection);
				await blocker.query('COMMIT');

				const error = await append;
				expect(error).toBeInstanceOf(SnapshotStoreVersionConflictException);
				expect(error).toEqual(new SnapshotStoreVersionConflictException(stream, 10, 10));
				expect(await getStoredVersions(appendCollection, stream)).toEqual({ versions: [10], latest: [10] });
			} finally {
				await blocker.end();
			}
		}, 15_000);

		it('should discard a connection that fails during an append', async () => {
			const stream = SnapshotStream.for(Account, AccountId.generate());
			await snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, appendPool);
			const blocker = new Client(connectionOptions);
			await blocker.connect();

			try {
				await blocker.query('BEGIN');
				await blocker.query(
					`INSERT INTO ${escapeIdentifier(appendCollection)} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name)
					VALUES ($1, 20, '{}', 'blocker', 'blocker', now(), 'account')`,
					[stream.streamId],
				);

				const append = snapshotStore.appendSnapshot(stream, 20, { balance: 20 }, appendPool).then(
					() => undefined,
					(error: Error) => error,
				);

				// The connection of the append is terminated while its transaction waits for the other writer
				const pid = await waitForBlockedInsert(appendCollection);
				await pool.query('SELECT pg_terminate_backend($1)', [pid]);

				expect(await append).toBeInstanceOf(SnapshotStorePersistenceException);
				await blocker.query('ROLLBACK');
			} finally {
				await blocker.end();
			}

			// The failed transaction was rolled back, so the previous snapshot is still the latest
			expect(await getStoredVersions(appendCollection, stream)).toEqual({ versions: [10], latest: [10] });
			await expect(snapshotStore.appendSnapshot(stream, 20, { balance: 20 }, appendPool)).resolves.toBeDefined();
			expect(pool.idleCount).toBe(pool.totalCount);
		}, 15_000);
	});

	describe('collections', () => {
		const longPoolA = `postgres-${'x'.repeat(40)}-a`;
		const longPoolB = `postgres-${'x'.repeat(40)}-b`;
		const tables = [
			SnapshotCollection.get('postgres-index'),
			SnapshotCollection.get('postgres-existing'),
			SnapshotCollection.get('postgres-race'),
			SnapshotCollection.get('postgres-quo"te'),
			SnapshotCollection.get('postgres-index-failure'),
			SnapshotCollection.get(longPoolA),
			SnapshotCollection.get(longPoolB),
		];

		const dropTables = async () => {
			await Promise.all(tables.map((table) => pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(table)}`)));
		};

		beforeAll(dropTables);
		afterAll(dropTables);
		afterEach(() => jest.restoreAllMocks());

		it('should create a secondary index for every new collection', async () => {
			const collection = await snapshotStore.ensureCollection('postgres-index');

			expect(await getIndexDefinitions(collection)).toEqual([
				'CREATE INDEX "idx_postgres-index-snapshots_aggregate_name_latest" ON public."postgres-index-snapshots" USING btree (aggregate_name, latest)',
				'CREATE UNIQUE INDEX "postgres-index-snapshots_pkey" ON public."postgres-index-snapshots" USING btree (stream_id, version)',
			]);
			expect(await getIndexDefinitions(SnapshotCollection.get())).toEqual([
				'CREATE INDEX idx_snapshots_aggregate_name_latest ON public.snapshots USING btree (aggregate_name, latest)',
				'CREATE UNIQUE INDEX snapshots_pkey ON public.snapshots USING btree (stream_id, version)',
			]);
		});

		it('should derive distinct index names within the identifier limit for long pool names', async () => {
			const collections = await Promise.all([
				snapshotStore.ensureCollection(longPoolA),
				snapshotStore.ensureCollection(longPoolB),
			]);

			const { rows } = await pool.query<{ tablename: string; indexname: string }>(
				`SELECT tablename, indexname FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ANY ($1) AND indexdef LIKE '%(aggregate_name, latest)'
				ORDER BY tablename COLLATE "C"`,
				[collections],
			);

			expect(rows.map(({ tablename }) => tablename)).toEqual(collections);
			expect(rows[0].indexname).not.toEqual(rows[1].indexname);
			for (const { indexname } of rows) {
				expect(Buffer.byteLength(indexname)).toBeLessThanOrEqual(63);
			}
		});

		it('should not build a missing index on an existing collection but log how to create it', async () => {
			const warn = jest.spyOn(snapshotStore['logger'], 'warn').mockImplementation(() => undefined);
			const table = SnapshotCollection.get('postgres-existing');
			const statement =
				'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_postgres-existing-snapshots_aggregate_name_latest" ON "postgres-existing-snapshots" (aggregate_name, latest)';

			await pool.query(
				`CREATE TABLE ${escapeIdentifier(table)} (
					stream_id VARCHAR(90) NOT NULL,
					version INT NOT NULL,
					payload JSONB NOT NULL,
					snapshot_id VARCHAR(40) NOT NULL,
					aggregate_id VARCHAR(40) NOT NULL,
					registered_on TIMESTAMP NOT NULL,
					aggregate_name VARCHAR(50) NOT NULL,
					latest VARCHAR(100),
					PRIMARY KEY (stream_id, version)
				)`,
			);
			await expect(snapshotStore.ensureCollection('postgres-existing')).resolves.toBe(table);

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(statement));
			expect(await getIndexDefinitions(table)).toEqual([
				'CREATE UNIQUE INDEX "postgres-existing-snapshots_pkey" ON public."postgres-existing-snapshots" USING btree (stream_id, version)',
			]);

			// The suggested statement creates the index, after which the warning is no longer logged
			await pool.query(statement);
			warn.mockClear();
			await snapshotStore.ensureCollection('postgres-existing');
			expect(warn).not.toHaveBeenCalled();
		});

		it('should roll back a new collection when its index cannot be created', async () => {
			const query = Client.prototype.query;
			jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
				if (typeof args[0] === 'string' && args[0].startsWith('CREATE INDEX IF NOT EXISTS')) {
					return Promise.reject(new Error('could not extend file'));
				}
				return query.apply(this, args);
			} as never);

			await expect(snapshotStore.ensureCollection('postgres-index-failure')).rejects.toThrow(
				SnapshotStoreCollectionCreationException,
			);

			const { rows } = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [
				escapeIdentifier(SnapshotCollection.get('postgres-index-failure')),
			]);
			expect(rows).toEqual([{ exists: false }]);
		});

		it('should ensure the same collection concurrently', async () => {
			const collections = await Promise.all(
				Array.from({ length: 8 }, () => snapshotStore.ensureCollection('postgres-race')),
			);

			expect(new Set(collections)).toEqual(new Set([SnapshotCollection.get('postgres-race')]));
			expect(await getIndexDefinitions(SnapshotCollection.get('postgres-race'))).toHaveLength(2);
		});

		it('should support pool names that need quoting', async () => {
			const quotedPool = 'postgres-quo"te';
			const stream = SnapshotStream.for(Account, AccountId.generate());

			const collection = await snapshotStore.ensureCollection(quotedPool);
			expect(collection).toBe('postgres-quo"te-snapshots');
			expect(await getIndexDefinitions(collection)).toHaveLength(2);

			const first = await snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, quotedPool);
			const last = await snapshotStore.appendSnapshot(stream, 20, { balance: 20 }, quotedPool);
			await expect(snapshotStore.appendSnapshot(stream, 20, { balance: 20 }, quotedPool)).rejects.toThrow(
				SnapshotStoreVersionConflictException,
			);

			await expect(snapshotStore.getSnapshot(stream, 10, quotedPool)).resolves.toEqual({ balance: 10 });
			await expect(snapshotStore.getEnvelope(stream, 10, quotedPool)).resolves.toEqual(first);
			await expect(snapshotStore.getLastSnapshot(stream, quotedPool)).resolves.toEqual({ balance: 20 });
			await expect(snapshotStore.getLastEnvelope(stream, quotedPool)).resolves.toEqual(last);
			expect(await snapshotStore.getLastSnapshots([stream], quotedPool)).toEqual(new Map([[stream, { balance: 20 }]]));
			expect(await snapshotStore.getManyLastSnapshotEnvelopes([stream], quotedPool)).toEqual(new Map([[stream, last]]));

			const resolvedSnapshots: ISnapshot<Account>[] = [];
			for await (const batch of snapshotStore.getSnapshots(stream, { pool: quotedPool })) {
				resolvedSnapshots.push(...batch);
			}
			expect(resolvedSnapshots).toEqual([{ balance: 10 }, { balance: 20 }]);

			const resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
			for await (const batch of snapshotStore.getEnvelopes(stream, { pool: quotedPool })) {
				resolvedEnvelopes.push(...batch);
			}
			expect(resolvedEnvelopes).toEqual([first, last]);

			const lastEnvelopes: SnapshotEnvelope<Account>[] = [];
			for await (const batch of snapshotStore.getLastEnvelopesForAggregate(Account, { pool: quotedPool })) {
				lastEnvelopes.push(...batch);
			}
			expect(lastEnvelopes).toEqual([last]);

			const collections: ISnapshotCollection[] = [];
			for await (const batch of snapshotStore.listCollections()) {
				collections.push(...batch);
			}
			expect(collections).toContain(collection);
		});
	});
});
