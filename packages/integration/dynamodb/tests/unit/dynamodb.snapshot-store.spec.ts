import { randomInt } from 'node:crypto';
import {
	BillingMode,
	CreateTableCommand,
	DeleteTableCommand,
	type DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
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
import { DynamoDBSnapshotStore } from '@ocoda/event-sourcing-dynamodb';
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

describe(DynamoDBSnapshotStore, () => {
	let snapshotStore: DynamoDBSnapshotStore;
	const envelopesAccountA = snapshotEnvelopesAccountA;
	const envelopesAccountB = snapshotEnvelopesAccountB;

	let client: DynamoDBClient;

	beforeAll(async () => {
		snapshotStore = new DynamoDBSnapshotStore({
			driver: undefined as never,
			region: 'us-east-1',
			endpoint: 'http://127.0.0.1:8000',
			credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
		});

		await snapshotStore.connect();
		await snapshotStore.ensureCollection();

		// biome-ignore lint/complexity/useLiteralKeys: Needed to check the internal workings of the event store
		client = snapshotStore['client'];
	});

	afterAll(async () => {
		await Promise.all([
			client.send(new DeleteTableCommand({ TableName: SnapshotCollection.get() })),
			client.send(new DeleteTableCommand({ TableName: SnapshotCollection.get('a') })),
			client.send(new DeleteTableCommand({ TableName: SnapshotCollection.get('b') })),
			client.send(new DeleteTableCommand({ TableName: SnapshotCollection.get('c') })),
		]);
		client.destroy();
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

		const { Items: itemsAccountA } = await client.send(
			new QueryCommand({
				TableName: SnapshotCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: snapshotStreamAccountA.streamId },
				},
			}),
		);

		const entitiesAccountA = itemsAccountA?.map((item) => unmarshall(item)) || [];

		const { Items: itemsAccountB } = await client.send(
			new QueryCommand({
				TableName: SnapshotCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: snapshotStreamAccountB.streamId },
				},
			}),
		);
		const entitiesAccountB = itemsAccountB?.map((item) => unmarshall(item)) || [];

		const { Items: itemsCustomer } = await client.send(
			new QueryCommand({
				TableName: SnapshotCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: snapshotStreamCustomer.streamId },
				},
			}),
		);
		const entitiesCustomer = itemsCustomer?.map((item) => unmarshall(item)) || [];

		expect(entitiesAccountA).toHaveLength(snapshotsAccountA.length);
		expect(entitiesAccountB).toHaveLength(snapshotsAccountB.length);
		expect(entitiesCustomer).toHaveLength(2);

		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.streamId).toEqual(snapshotStreamAccountA.streamId);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(typeof entity.registeredOn).toBe('number');
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);

			if (index === entitiesAccountA.length - 1) {
				expect(entity.latest).toEqual(`latest#${snapshotStreamAccountA.streamId}`);
			} else {
				expect(entity.latest).toBeUndefined();
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
			envelopesAccountA[2].metadata.version,
		);

		expect(resolvedSnapshot).toEqual(snapshotsAccountA[2]);
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
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { fromVersion: 30 })) {
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

	describe('transactional appends', () => {
		const pool = 'dynamodb-appends';
		const collection = SnapshotCollection.get(pool);

		@Aggregate({ streamName: 'dynamodb-ledger' })
		class Ledger extends AggregateRoot {
			public balance: number;
			public openedAt?: Date;
			public history?: unknown[];
		}

		class LedgerId extends UUID {}

		const newStream = () => SnapshotStream.for(Ledger, LedgerId.generate());

		const readItems = async ({ streamId }: SnapshotStream) => {
			const { Items } = await client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: 'streamId = :streamId',
					ExpressionAttributeValues: { ':streamId': { S: streamId } },
					ConsistentRead: true,
				}),
			);
			return (Items || []).map((item) => unmarshall(item));
		};

		// Makes the version check see an empty stream, like a stale (eventually consistent) read or a concurrent writer would
		const simulateStaleVersionCheck = () => {
			const send = client.send.bind(client);
			return jest
				.spyOn(client, 'send')
				.mockImplementation((async (command: unknown) =>
					command instanceof QueryCommand && command.input.Limit === 1
						? { Items: [], $metadata: {} }
						: send(command as QueryCommand)) as any);
		};

		// Holds every transaction until `count` of them were sent, so they all race each other
		const raceTransactions = (count: number) => {
			const send = client.send.bind(client);
			let arrived = 0;
			let release: () => void = () => undefined;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			return jest.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
				if (command instanceof TransactWriteItemsCommand) {
					arrived++;
					if (arrived === count) {
						release();
					}
					await released;
				}
				return send(command as QueryCommand);
			}) as any);
		};

		beforeAll(async () => {
			await snapshotStore.ensureCollection(pool);
		});

		afterEach(() => {
			jest.restoreAllMocks();
		});

		afterAll(async () => {
			await Promise.all(
				[collection, SnapshotCollection.get('dynamodb-concurrent')].map((TableName) =>
					client.send(new DeleteTableCommand({ TableName })).catch(() => undefined),
				),
			);
		});

		it('should not overwrite an existing snapshot when the version check reads stale data', async () => {
			const stream = newStream();
			await snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, pool);
			const storedItems = await readItems(stream);

			simulateStaleVersionCheck();

			const append = snapshotStore.appendSnapshot(stream, 10, { balance: 999 }, pool);
			await expect(append).rejects.toThrow(new SnapshotStoreVersionConflictException(stream, 10, 10));
			await expect(append).rejects.toHaveProperty('stack', expect.stringContaining('ConditionalCheckFailed'));

			jest.restoreAllMocks();
			expect(await readItems(stream)).toEqual(storedItems);
			expect(storedItems).toHaveLength(1);
			expect(storedItems[0].payload).toEqual({ balance: 10 });
		});

		it('should let exactly one of several concurrent appenders of the same version win', async () => {
			const stream = newStream();
			const snapshots = Array.from({ length: 10 }, (_, writer) => ({ balance: writer }));

			const results = await Promise.allSettled(
				snapshots.map((snapshot) => snapshotStore.appendSnapshot(stream, 10, snapshot, pool)),
			);

			const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
			expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
			expect(rejected).toHaveLength(9);
			for (const { reason } of rejected) {
				expect(reason).toBeInstanceOf(SnapshotStoreVersionConflictException);
			}

			const winner = snapshots[results.findIndex(({ status }) => status === 'fulfilled')];
			const items = await readItems(stream);
			expect(items).toHaveLength(1);
			expect(items[0].payload).toEqual(winner);
			expect(items[0].latest).toBe(`latest#${stream.streamId}`);
		});

		it('should let exactly one of several racing appenders move the latest marker', async () => {
			const stream = newStream();
			await snapshotStore.appendSnapshot(stream, 1, { balance: 1 }, pool);
			const versions = [10, 20, 30, 40, 50];

			raceTransactions(versions.length);

			const results = await Promise.allSettled(
				versions.map((version) => snapshotStore.appendSnapshot(stream, version, { balance: version }, pool)),
			);

			jest.restoreAllMocks();

			const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
			expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
			expect(rejected).toHaveLength(versions.length - 1);
			for (const { reason } of rejected) {
				expect(reason).toBeInstanceOf(SnapshotStoreVersionConflictException);
				// Raised by the conditional transaction, not by the version check
				expect(reason.stack).toContain('TransactionCanceledException');
			}

			const winner = versions[results.findIndex(({ status }) => status === 'fulfilled')];
			const items = await readItems(stream);
			expect(items.map(({ version }) => version)).toEqual([1, winner]);
			expect(items.filter(({ latest }) => latest !== undefined).map(({ version }) => version)).toEqual([winner]);

			const lastEnvelope = await snapshotStore.getLastEnvelope(stream, pool);
			expect(lastEnvelope?.metadata.version).toBe(winner);
		});

		it('should store dates in snapshot payloads as ISO strings', async () => {
			const stream = newStream();
			const openedAt = new Date('2024-02-29T23:59:59.999Z');
			const note = `It's O'Brien's "quoted" note: ÄÖÜ ß 你好 🚀`;
			const snapshot = {
				balance: 42,
				openedAt,
				history: [{ at: new Date('2020-01-01T00:00:00.000Z'), note }, [['nested'], { deeper: { at: openedAt } }]],
			};
			const expectedPayload = JSON.parse(JSON.stringify(snapshot));

			await snapshotStore.appendSnapshot(stream, 1, snapshot, pool);

			const [item] = await readItems(stream);
			expect(item.payload).toEqual(expectedPayload);
			expect(item.payload.openedAt).toBe('2024-02-29T23:59:59.999Z');
			expect(item.payload.history[0].at).toBe('2020-01-01T00:00:00.000Z');
			expect(item.payload.history[0].note).toBe(note);

			expect(await snapshotStore.getSnapshot(stream, 1, pool)).toEqual(expectedPayload);
			expect(await snapshotStore.getLastSnapshot(stream, pool)).toEqual(expectedPayload);
			expect((await snapshotStore.getEnvelope(stream, 1, pool)).payload).toEqual(expectedPayload);
		});

		it('should read streams strongly consistently and send a fresh idempotency token per append', async () => {
			const stream = newStream();
			const drain = async <T>(generator: AsyncGenerator<T[]>) => {
				const items: T[] = [];
				for await (const batch of generator) {
					items.push(...batch);
				}
				return items;
			};
			const send = jest.spyOn(client, 'send');

			await snapshotStore.appendSnapshot(stream, 1, { balance: 1 }, pool);
			await snapshotStore.appendSnapshot(stream, 10, { balance: 10 }, pool);
			await snapshotStore.getSnapshot(stream, 1, pool);
			await snapshotStore.getEnvelope(stream, 1, pool);
			await snapshotStore.getLastSnapshot(stream, pool);
			expect(await drain(snapshotStore.getSnapshots(stream, { pool }))).toHaveLength(2);
			expect(await drain(snapshotStore.getEnvelopes(stream, { pool }))).toHaveLength(2);
			expect((await snapshotStore.getLastEnvelope(stream, pool))?.metadata.version).toBe(10);
			await snapshotStore.getLastSnapshots([stream], pool);
			await snapshotStore.getManyLastSnapshotEnvelopes([stream], pool);
			await drain(snapshotStore.getLastEnvelopesForAggregate(Ledger, { pool }));

			const commands = send.mock.calls.map(([command]) => command);
			const reads = commands
				.filter((command) => command instanceof QueryCommand || command instanceof GetItemCommand)
				.map(({ input }) => input as { IndexName?: string; ConsistentRead?: boolean });
			const tableReads = reads.filter(({ IndexName }) => !IndexName);
			const indexReads = reads.filter(({ IndexName }) => IndexName);

			// 2 version checks, getSnapshot, getEnvelope, getLastSnapshot, getSnapshots and getEnvelopes
			expect(tableReads).toHaveLength(7);
			for (const input of tableReads) {
				expect(input.ConsistentRead).toBe(true);
			}
			// Global secondary indexes don't support consistent reads
			expect(indexReads).toHaveLength(4);
			for (const input of indexReads) {
				expect(input).not.toHaveProperty('ConsistentRead');
			}

			const transactions = commands
				.filter((command): command is TransactWriteItemsCommand => command instanceof TransactWriteItemsCommand)
				.map(({ input }) => input);
			expect(transactions).toHaveLength(2);
			const tokens = transactions.map(({ ClientRequestToken }) => ClientRequestToken);
			expect(new Set(tokens).size).toBe(2);
			for (const token of tokens) {
				expect(token).toMatch(/^[0-9a-f-]{36}$/);
			}
			const [first, second] = transactions;
			expect(first.TransactItems?.map(({ Put, Update }) => (Put ?? Update)?.ConditionExpression)).toEqual([
				'attribute_not_exists(streamId)',
			]);
			expect(second.TransactItems?.map(({ Put, Update }) => (Put ?? Update)?.ConditionExpression)).toEqual([
				'latest = :latest',
				'attribute_not_exists(streamId)',
			]);
		});

		it('should throw when a collection cannot be created', async () => {
			const send = client.send.bind(client);
			jest
				.spyOn(client, 'send')
				.mockImplementation((async (command: unknown) =>
					command instanceof CreateTableCommand
						? Promise.reject(new Error('LimitExceededException'))
						: send(command as QueryCommand)) as any);

			await expect(snapshotStore.ensureCollection('dynamodb-create-failure')).rejects.toThrow(
				new SnapshotStoreCollectionCreationException('dynamodb-create-failure-snapshots', new Error()),
			);
		});

		it('should create the same collection concurrently without provisioned throughput', async () => {
			const send = jest.spyOn(client, 'send');

			await expect(
				Promise.all([
					snapshotStore.ensureCollection('dynamodb-concurrent'),
					snapshotStore.ensureCollection('dynamodb-concurrent'),
				]),
			).resolves.toEqual(['dynamodb-concurrent-snapshots', 'dynamodb-concurrent-snapshots']);

			const inputs = send.mock.calls
				.map(([command]) => command)
				.filter((command): command is CreateTableCommand => command instanceof CreateTableCommand)
				.map(({ input }) => input);
			expect(inputs.length).toBeGreaterThanOrEqual(1);
			for (const input of inputs) {
				expect(input.BillingMode).toBe(BillingMode.PAY_PER_REQUEST);
				expect(input).not.toHaveProperty('ProvisionedThroughput');
				expect(input.GlobalSecondaryIndexes?.[0]).not.toHaveProperty('ProvisionedThroughput');
			}
		});
	});
});
