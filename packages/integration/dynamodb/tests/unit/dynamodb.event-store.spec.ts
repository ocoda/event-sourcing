import {
	BillingMode,
	CreateTableCommand,
	type CreateTableCommandInput,
	DeleteTableCommand,
	DescribeTableCommand,
	type DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	TableStatus,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
	DefaultEventSerializer,
	Event,
	EventCollection,
	type EventEnvelope,
	EventId,
	EventNotFoundException,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	type IEvent,
	type IEventCollection,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { DynamoDBEventStore } from '@ocoda/event-sourcing-dynamodb';
import {
	Account,
	AccountId,
	eventStreamAccountA,
	eventStreamAccountB,
	getAccountAEventEnvelopes,
	getAccountBEventEnvelopes,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';

describe(DynamoDBEventStore, () => {
	let eventStore: DynamoDBEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	const publish = jest.fn(async () => Promise.resolve());

	let client: DynamoDBClient;

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(async () => {
		eventStore = new DynamoDBEventStore(eventMap, {
			driver: undefined as never,
			region: 'us-east-1',
			endpoint: 'http://127.0.0.1:8000',
			credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
		});
		eventStore.publish = publish;

		await eventStore.connect();
		await eventStore.ensureCollection();

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);

		// biome-ignore lint/complexity/useLiteralKeys: Needed to check the internal workings of the event store
		client = eventStore['client'];
	});

	afterAll(async () => {
		await Promise.all([
			client.send(new DeleteTableCommand({ TableName: EventCollection.get() })),
			client.send(new DeleteTableCommand({ TableName: EventCollection.get('test-singular-events') })),
			client.send(new DeleteTableCommand({ TableName: EventCollection.get('a') })),
			client.send(new DeleteTableCommand({ TableName: EventCollection.get('b') })),
			client.send(new DeleteTableCommand({ TableName: EventCollection.get('c') })),
		]);
		client.destroy();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, envelopesAccountA.length, envelopesAccountA);
		await eventStore.appendEvents(eventStreamAccountB, envelopesAccountB.length, envelopesAccountB);

		const { Items: itemsAccountA } = await client.send(
			new QueryCommand({
				TableName: EventCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: eventStreamAccountA.streamId },
				},
			}),
		);
		const entitiesAccountA = itemsAccountA?.map((item) => unmarshall(item)) || [];

		const { Items: itemsAccountB } = await client.send(
			new QueryCommand({
				TableName: EventCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: eventStreamAccountB.streamId },
				},
			}),
		);
		const entitiesAccountB = itemsAccountB?.map((item) => unmarshall(item)) || [];

		expect(entitiesAccountA).toHaveLength(events.length);
		expect(entitiesAccountB).toHaveLength(events.length);

		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountA.streamId);
			expect(entity.event).toEqual(envelopesAccountA[index].event);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(typeof entity.eventId).toBe('string');
			expect(entity.occurredOn).toEqual(envelopesAccountA[index].metadata.occurredOn.getTime());
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(typeof entity.eventId).toBe('string');
			expect(entity.occurredOn).toEqual(envelopesAccountB[index].metadata.occurredOn.getTime());
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
		}

		expect(publish).toHaveBeenCalledTimes(events.length * 2);
	});

	it('should append events', async () => {
		const accountId = AccountId.generate();
		const eventStreamAccountC = EventStream.for(Account, accountId);
		const envelopesAccountC = getAccountEventEnvelopes(accountId, eventMap, events);

		await eventStore.ensureCollection('test-singular-events');
		await eventStore.appendEvents(eventStreamAccountC, envelopesAccountC.length, events, 'test-singular-events');

		const { Items: itemsAccountC } = await client.send(
			new QueryCommand({
				TableName: EventCollection.get('test-singular-events'),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: eventStreamAccountC.streamId },
				},
			}),
		);
		const entitiesAccountC = itemsAccountC?.map((item) => unmarshall(item)) || [];

		for (const [index, entity] of entitiesAccountC.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountC.streamId);
			expect(entity.event).toEqual(envelopesAccountC[index].event);
			expect(entity.payload).toEqual(envelopesAccountC[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountC[index].metadata.aggregateId);
			expect(typeof entity.eventId).toBe('string');
			expect(typeof entity.occurredOn).toBe('number');
			expect(entity.version).toEqual(envelopesAccountC[index].metadata.version);
		}
	});

	it('should throw when trying to append an event to a stream that has a version lower or equal to the latest event for that stream', async () => {
		const lastEvent = events[events.length - 1];
		const lastVersion = events.length;
		const beforeLastVersion = lastVersion - 1;
		await expect(eventStore.appendEvents(eventStreamAccountA, beforeLastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, beforeLastVersion, lastVersion),
		);
		await expect(eventStore.appendEvents(eventStreamAccountA, lastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, lastVersion, lastVersion),
		);
	});

	it("should throw when event envelopes can't be appended", async () => {
		await expect(eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3), 'not-a-pool')).rejects.toThrow(
			EventStorePersistenceException,
		);
	});

	it('should retrieve a single event from a specified stream', async () => {
		const resolvedEvent = await eventStore.getEvent(eventStreamAccountA, envelopesAccountA[3].metadata.version);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it('should filter events by stream', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA)) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events);
	});

	it('should filter events by stream and version', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			fromVersion: 3,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it("should throw when an event isn't found in a specified stream", async () => {
		const stream = EventStream.for(Account, AccountId.generate());
		await expect(eventStore.getEvent(stream, 5)).rejects.toThrow(new EventNotFoundException(stream.streamId, 5));
	});

	it('should retrieve events backwards', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events backwards from a certain version', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			fromVersion: 4,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(3).reverse());
	});

	it('should limit the returned events', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			limit: 3,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(0, 3));
	});

	it('should batch the returned events', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			batch: 2,
		})) {
			expect(events.length).toBe(2);
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event-envelope', async () => {
		const { event, metadata, payload } = await eventStore.getEnvelope(
			eventStreamAccountA,
			envelopesAccountA[3].metadata.version,
		);

		expect(event).toEqual(envelopesAccountA[3].event);
		expect(payload).toEqual(envelopesAccountA[3].payload);
		expect(metadata.aggregateId).toEqual(envelopesAccountA[3].metadata.aggregateId);
		expect(metadata.eventId).toBeInstanceOf(EventId);
		expect(metadata.occurredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopesAccountA[3].metadata.version);
	});

	it('should retrieve event-envelopes', async () => {
		const resolvedEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getEnvelopes(eventStreamAccountA)) {
			resolvedEnvelopes.push(...envelopes);
		}

		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);

		for (const [index, envelope] of resolvedEnvelopes.entries()) {
			expect(envelope.event).toEqual(envelopesAccountA[index].event);
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.eventId).toBeInstanceOf(EventId);
			expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
		}
	});

	it('should retrieve all event-envelopes since a specified time', async () => {
		const seedAllEnvelopes = [...envelopesAccountA, ...envelopesAccountB].sort((a, b) =>
			a.metadata.eventId.value < b.metadata.eventId.value ? -1 : 1,
		);

		const resolvedAllEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getAllEnvelopes({ since: { year: 2021, month: 1 } })) {
			resolvedAllEnvelopes.push(...envelopes);
		}

		expect(resolvedAllEnvelopes).toHaveLength(envelopesAccountA.length + envelopesAccountB.length);

		for (const [index, envelope] of resolvedAllEnvelopes.entries()) {
			expect(envelope.event).toEqual(seedAllEnvelopes[index].event);
			expect(envelope.payload).toEqual(seedAllEnvelopes[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(seedAllEnvelopes[index].metadata.aggregateId);
			expect(envelope.metadata.eventId.value).toEqual(seedAllEnvelopes[index].metadata.eventId.value);
			expect(envelope.metadata.version).toEqual(seedAllEnvelopes[index].metadata.version);
		}
	});

	it('should retrieve all event-envelopes batched', async () => {
		const resolvedBatchedEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getAllEnvelopes({ since: { year: 2021, month: 1 }, batch: 2 })) {
			expect(envelopes.length).toBe(2);
			resolvedBatchedEnvelopes.push(...envelopes);
		}
	});

	it('should list collections', async () => {
		await Promise.all([
			eventStore.ensureCollection('a'),
			eventStore.ensureCollection('b'),
			eventStore.ensureCollection('c'),
		]);

		const resolvedCollections: IEventCollection[] = [];
		for await (const collections of eventStore.listCollections()) {
			resolvedCollections.push(...collections);
		}

		expect(resolvedCollections.includes('a-events')).toBe(true);
		expect(resolvedCollections.includes('b-events')).toBe(true);
		expect(resolvedCollections.includes('c-events')).toBe(true);
	});

	describe('transactional appends', () => {
		const pool = 'dynamodb-appends';
		const collection = EventCollection.get(pool);

		@Event('dynamodb-counted')
		class CountedEvent implements IEvent {
			constructor(public readonly count: number) {}
		}

		@Event('dynamodb-payload-recorded')
		class PayloadRecordedEvent implements IEvent {
			constructor(
				public readonly recordedAt: Date,
				public readonly details: Record<string, unknown>,
			) {}
		}

		const newStream = () => EventStream.for(Account, AccountId.generate());
		const countedEvents = (length: number, offset = 0) =>
			Array.from({ length }, (_, index) => new CountedEvent(offset + index + 1));

		const readItems = async ({ streamId }: EventStream) => {
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
			eventMap.register(CountedEvent, DefaultEventSerializer.for(CountedEvent));
			eventMap.register(PayloadRecordedEvent, DefaultEventSerializer.for(PayloadRecordedEvent));
			await eventStore.ensureCollection(pool);
		});

		afterEach(() => {
			jest.restoreAllMocks();
		});

		afterAll(async () => {
			await client.send(new DeleteTableCommand({ TableName: collection }));
		});

		it.each([26, 100])('should append %i events in a single call', async (count) => {
			const stream = newStream();
			const events = countedEvents(count);

			const envelopes = await eventStore.appendEvents(stream, count, events, pool);

			expect(envelopes).toHaveLength(count);

			const items = await readItems(stream);
			expect(items.map(({ version }) => version)).toEqual(events.map((_, index) => index + 1));
			expect(items.map(({ payload }) => payload.count)).toEqual(events.map(({ count }) => count));

			const resolvedEvents: IEvent[] = [];
			for await (const batch of eventStore.getEvents(stream, { pool })) {
				resolvedEvents.push(...batch);
			}
			expect(resolvedEvents).toEqual(events);
		});

		it('should reject appending more than 100 events before writing anything', async () => {
			const stream = newStream();
			const send = jest.spyOn(client, 'send');

			const append = eventStore.appendEvents(stream, 101, countedEvents(101), pool);

			await expect(append).rejects.toThrow(new EventStorePersistenceException(collection, new Error()));
			await expect(append).rejects.toHaveProperty(
				'stack',
				expect.stringContaining('DynamoDB transactions are limited to 100 items'),
			);
			expect(send).not.toHaveBeenCalled();

			send.mockRestore();
			expect(await readItems(stream)).toHaveLength(0);
		});

		it('should not overwrite the first event of an existing stream', async () => {
			const stream = newStream();
			await eventStore.appendEvents(stream, 1, countedEvents(1), pool);
			const [storedItem] = await readItems(stream);

			await expect(eventStore.appendEvents(stream, 1, countedEvents(1, 100), pool)).rejects.toThrow(
				new EventStoreVersionConflictException(stream, 1, 1),
			);

			expect(await readItems(stream)).toEqual([storedItem]);
			expect(storedItem.payload).toEqual({ count: 1 });
		});

		it('should not overwrite existing events when the version check reads stale data', async () => {
			const stream = newStream();
			await eventStore.appendEvents(stream, 3, countedEvents(3), pool);
			const storedItems = await readItems(stream);

			simulateStaleVersionCheck();

			// Versions 3 and 4: version 3 already exists, so nothing may be written
			const append = eventStore.appendEvents(stream, 4, countedEvents(2, 100), pool);
			await expect(append).rejects.toThrow(new EventStoreVersionConflictException(stream, 4, 4));
			await expect(append).rejects.toHaveProperty('stack', expect.stringContaining('ConditionalCheckFailed'));

			jest.restoreAllMocks();
			expect(await readItems(stream)).toEqual(storedItems);
		});

		it('should let exactly one of several concurrent appenders win', async () => {
			const stream = newStream();
			const writers = Array.from({ length: 10 }, (_, writer) => countedEvents(3, writer * 100));

			const results = await Promise.allSettled(
				writers.map((events) => eventStore.appendEvents(stream, 3, events, pool)),
			);

			const fulfilled = results.filter(({ status }) => status === 'fulfilled');
			const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(9);
			for (const { reason } of rejected) {
				expect(reason).toBeInstanceOf(EventStoreVersionConflictException);
			}

			const winner = writers[results.findIndex(({ status }) => status === 'fulfilled')];
			const items = await readItems(stream);
			expect(items.map(({ version }) => version)).toEqual([1, 2, 3]);
			expect(items.map(({ payload }) => payload.count)).toEqual(winner.map(({ count }) => count));
		});

		it('should let exactly one of several racing transactions win', async () => {
			const stream = newStream();
			const writers = Array.from({ length: 5 }, (_, writer) => countedEvents(2, writer * 100));

			raceTransactions(writers.length);

			const results = await Promise.allSettled(
				writers.map((events) => eventStore.appendEvents(stream, 2, events, pool)),
			);

			jest.restoreAllMocks();

			const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
			expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
			expect(rejected).toHaveLength(writers.length - 1);
			for (const { reason } of rejected) {
				expect(reason).toBeInstanceOf(EventStoreVersionConflictException);
				// Raised by the conditional transaction, not by the version check
				expect(reason.stack).toContain('TransactionCanceledException');
			}

			const winner = writers[results.findIndex(({ status }) => status === 'fulfilled')];
			const items = await readItems(stream);
			expect(items.map(({ version }) => version)).toEqual([1, 2]);
			expect(items.map(({ payload }) => payload.count)).toEqual(winner.map(({ count }) => count));
		});

		it('should store dates in payloads as ISO strings', async () => {
			const stream = newStream();
			const recordedAt = new Date('2024-02-29T23:59:59.999Z');
			const details = {
				note: `It's O'Brien's "quoted" note: ÄÖÜ ß 你好 🚀`,
				tags: ['a', ['nested', ['deeper']], { at: new Date('2020-01-01T00:00:00.000Z') }],
				nested: { level: { deeper: { at: recordedAt, empty: [], flag: true, nothing: null } } },
			};
			const event = new PayloadRecordedEvent(recordedAt, details);
			const expectedPayload = JSON.parse(JSON.stringify(eventMap.serializeEvent(event)));

			// The default serializer keeps Date instances, which used to be stored as empty maps
			expect(eventMap.serializeEvent(event).recordedAt).toBeInstanceOf(Date);

			await eventStore.appendEvents(stream, 1, [event], pool);

			const [item] = await readItems(stream);
			expect(item.payload).toEqual(expectedPayload);
			expect(item.payload.recordedAt).toBe('2024-02-29T23:59:59.999Z');
			expect(item.payload.details.tags[2].at).toBe('2020-01-01T00:00:00.000Z');
			expect(item.payload.details.note).toBe(details.note);

			const envelope = await eventStore.getEnvelope(stream, 1, pool);
			expect(envelope.payload).toEqual(expectedPayload);

			const resolvedEvent = (await eventStore.getEvent(stream, 1, pool)) as PayloadRecordedEvent;
			expect(resolvedEvent).toBeInstanceOf(PayloadRecordedEvent);
			expect(resolvedEvent.details).toEqual(expectedPayload.details);
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

			await eventStore.appendEvents(stream, 2, countedEvents(2), pool);
			await eventStore.appendEvents(stream, 3, countedEvents(1, 2), pool);
			await eventStore.getEvent(stream, 1, pool);
			await eventStore.getEnvelope(stream, 1, pool);
			expect(await drain(eventStore.getEvents(stream, { pool }))).toHaveLength(3);
			expect(await drain(eventStore.getEnvelopes(stream, { pool }))).toHaveLength(3);
			const now = new Date();
			await drain(eventStore.getAllEnvelopes({ pool, since: { year: now.getFullYear(), month: now.getMonth() + 1 } }));

			const commands = send.mock.calls.map(([command]) => command);
			const reads = commands
				.filter((command) => command instanceof QueryCommand || command instanceof GetItemCommand)
				.map(({ input }) => input as { IndexName?: string; ConsistentRead?: boolean });
			const tableReads = reads.filter(({ IndexName }) => !IndexName);
			const indexReads = reads.filter(({ IndexName }) => IndexName);

			// 2 version checks, getEvent, getEnvelope, getEvents and getEnvelopes
			expect(tableReads).toHaveLength(6);
			for (const input of tableReads) {
				expect(input.ConsistentRead).toBe(true);
			}
			// Global secondary indexes don't support consistent reads
			expect(indexReads.length).toBeGreaterThanOrEqual(1);
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
			for (const { TransactItems } of transactions) {
				for (const item of TransactItems || []) {
					expect(item.Put?.ConditionExpression).toBe('attribute_not_exists(streamId)');
				}
			}
		});
	});

	describe('ensureCollection', () => {
		const pools = ['dynamodb-on-demand', 'dynamodb-provisioned', 'dynamodb-concurrent'];

		const createTableInputs = (send: jest.SpyInstance) =>
			send.mock.calls
				.map(([command]) => command)
				.filter((command): command is CreateTableCommand => command instanceof CreateTableCommand)
				.map(({ input }): CreateTableCommandInput => input);

		afterEach(() => {
			jest.restoreAllMocks();
		});

		afterAll(async () => {
			await Promise.all(
				pools.map((pool) =>
					client.send(new DeleteTableCommand({ TableName: EventCollection.get(pool) })).catch(() => undefined),
				),
			);
		});

		it('should not provision throughput for on-demand tables and wait until they are active', async () => {
			const send = jest.spyOn(client, 'send');

			await expect(eventStore.ensureCollection('dynamodb-on-demand')).resolves.toBe('dynamodb-on-demand-events');

			const [input] = createTableInputs(send);
			expect(input.BillingMode).toBe(BillingMode.PAY_PER_REQUEST);
			expect(input).not.toHaveProperty('ProvisionedThroughput');
			expect(input.GlobalSecondaryIndexes).toHaveLength(1);
			expect(input.GlobalSecondaryIndexes?.[0]).not.toHaveProperty('ProvisionedThroughput');

			const { Table } = await client.send(new DescribeTableCommand({ TableName: 'dynamodb-on-demand-events' }));
			expect(Table?.TableStatus).toBe(TableStatus.ACTIVE);
		});

		it('should provision throughput for the table and its index for provisioned tables', async () => {
			const send = jest.spyOn(client, 'send');
			const ProvisionedThroughput = { ReadCapacityUnits: 2, WriteCapacityUnits: 3 };

			await eventStore.ensureCollection('dynamodb-provisioned', {
				BillingMode: BillingMode.PROVISIONED,
				ProvisionedThroughput,
			});

			const [input] = createTableInputs(send);
			expect(input.BillingMode).toBe(BillingMode.PROVISIONED);
			expect(input.ProvisionedThroughput).toEqual(ProvisionedThroughput);
			expect(input.GlobalSecondaryIndexes?.[0].ProvisionedThroughput).toEqual(ProvisionedThroughput);

			const { Table } = await client.send(new DescribeTableCommand({ TableName: 'dynamodb-provisioned-events' }));
			expect(Table?.GlobalSecondaryIndexes?.[0].ProvisionedThroughput).toMatchObject(ProvisionedThroughput);
		});

		it('should throw when a collection cannot be created', async () => {
			const send = client.send.bind(client);
			jest
				.spyOn(client, 'send')
				.mockImplementation((async (command: unknown) =>
					command instanceof CreateTableCommand
						? Promise.reject(new Error('LimitExceededException'))
						: send(command as QueryCommand)) as any);

			await expect(eventStore.ensureCollection('dynamodb-create-failure')).rejects.toThrow(
				new EventStoreCollectionCreationException('dynamodb-create-failure-events', new Error()),
			);
		});

		it('should create the same collection concurrently', async () => {
			await expect(
				Promise.all([
					eventStore.ensureCollection('dynamodb-concurrent'),
					eventStore.ensureCollection('dynamodb-concurrent'),
				]),
			).resolves.toEqual(['dynamodb-concurrent-events', 'dynamodb-concurrent-events']);
		});
	});
});
