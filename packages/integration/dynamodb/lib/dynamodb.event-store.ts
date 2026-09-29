import { randomUUID } from 'node:crypto';
import {
	type AttributeValue,
	type CreateTableCommandInput,
	DynamoDBClient,
	GetItemCommand,
	ListTablesCommand,
	QueryCommand,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventStore,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	type EventStream,
	type IAllEventsFilter,
	type IEvent,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventFilter,
	type IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { MAX_TRANSACTION_ITEMS, ensureTable, isConflictingTransaction, normalizePayload } from './helpers/index.js';
import type { DynamoDBEventStoreConfig, DynamoEventEntity } from './interfaces/index.js';

export class DynamoDBEventStore extends EventStore<DynamoDBEventStoreConfig> {
	private client: DynamoDBClient;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.client = new DynamoDBClient(this.options);
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.client.destroy();
	}

	public async ensureCollection(
		pool?: IEventPool,
		config?: Pick<CreateTableCommandInput, 'BillingMode' | 'ProvisionedThroughput' | 'OnDemandThroughput'>,
	): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);

		try {
			await ensureTable(
				this.client,
				{
					TableName: collection,
					KeySchema: [
						{ AttributeName: 'streamId', KeyType: 'HASH' },
						{ AttributeName: 'version', KeyType: 'RANGE' },
					],
					AttributeDefinitions: [
						{ AttributeName: 'streamId', AttributeType: 'S' },
						{ AttributeName: 'version', AttributeType: 'N' },
						{ AttributeName: 'eventDate', AttributeType: 'S' },
						{ AttributeName: 'eventId', AttributeType: 'S' },
					],
					GlobalSecondaryIndexes: [
						{
							IndexName: 'eventIdIndex',
							KeySchema: [
								{ AttributeName: 'eventDate', KeyType: 'HASH' },
								{ AttributeName: 'eventId', KeyType: 'RANGE' },
							],
							Projection: { ProjectionType: 'ALL' },
						},
					],
				},
				config,
			);

			return collection;
		} catch (err) {
			throw new EventStoreCollectionCreationException(collection, err);
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const entities: IEventCollection[] = [];
		let ExclusiveStartTableName: string | undefined;
		do {
			const { TableNames, LastEvaluatedTableName } = await this.client.send(
				new ListTablesCommand({
					ExclusiveStartTableName,
					Limit: batch,
				}),
			);

			ExclusiveStartTableName = LastEvaluatedTableName;
			entities.push(...((TableNames || []).filter((name) => name.endsWith('events')) as IEventCollection[]));

			if (entities.length > 0 && !ExclusiveStartTableName) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartTableName);
	}

	async *getEvents({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['streamId = :streamId'];
		const ExpressionAttributeValues = {
			':streamId': { S: streamId },
		};

		if (fromVersion) {
			KeyConditionExpression.push('version >= :fromVersion');
			ExpressionAttributeValues[':fromVersion'] = { N: fromVersion.toString() };
		}

		const entities: IEvent[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'event, payload',
					ConsistentRead: true,
					...(direction === StreamReadingDirection.BACKWARD && { ScanIndexForward: false }),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			entities.push(
				...(Items || []).map((item) => {
					const entity = this.hydrate<['event', 'payload']>(item);
					return this.eventMap.deserializeEvent(entity.event, entity.payload);
				}),
			);
			leftToFetch -= Items?.length || 0;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);
		const { Item } = await this.client.send(
			new GetItemCommand({
				TableName: collection,
				Key: marshall({ streamId, version }, { removeUndefinedValues: true }),
				ProjectionExpression: 'event, payload',
				ConsistentRead: true,
			}),
		);

		if (!Item) {
			throw new EventNotFoundException(streamId, version);
		}

		const entity = this.hydrate<['event', 'payload']>(Item);

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	/**
	 * Appends events to a stream in a single DynamoDB transaction (TransactWriteItems): either all events are
	 * stored, or none are. Every event is written with a condition on its (streamId, version) key, so an existing
	 * version is never overwritten; losing that race to a concurrent writer raises an EventStoreVersionConflictException.
	 *
	 * DynamoDB limits a transaction to 100 items and 4 MB in total, so at most 100 events (of at most 400 KB each)
	 * can be appended per call. Larger appends are rejected with an EventStorePersistenceException before anything
	 * is written. Transactional writes consume twice the write capacity of regular writes.
	 */
	async appendEvents(
		stream: EventStream,
		aggregateVersion: number,
		events: IEvent[] | EventEnvelope[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		if (events.length > MAX_TRANSACTION_ITEMS) {
			throw new EventStorePersistenceException(
				collection,
				new Error(
					`Cannot append ${events.length} events to the ${stream.streamId} stream at once: DynamoDB transactions are limited to ${MAX_TRANSACTION_ITEMS} items. Append at most ${MAX_TRANSACTION_ITEMS} events per call.`,
				),
			);
		}

		try {
			const currentVersion = await this.getCurrentVersion(collection, stream);

			if (currentVersion !== undefined && aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

			let version = aggregateVersion - events.length + 1;

			const envelopes: EventEnvelope[] = [];
			const eventIdFactory = EventId.factory();
			for (const event of events) {
				if (event instanceof EventEnvelope) {
					envelopes.push(event);
					continue;
				}

				const name = this.eventMap.getName(event);
				const payload = this.eventMap.serializeEvent(event);
				const envelope = EventEnvelope.create(name, payload, {
					aggregateId: stream.aggregateId,
					eventId: eventIdFactory(),
					version: version++,
				});
				envelopes.push(envelope);
			}

			await this.client.send(
				new TransactWriteItemsCommand({
					// Makes retries of a transaction that was already applied idempotent (for 10 minutes)
					ClientRequestToken: randomUUID(),
					TransactItems: envelopes.map(({ event, payload, metadata }) => ({
						Put: {
							TableName: collection,
							Item: marshall(
								{
									streamId: stream.streamId,
									event,
									payload: normalizePayload(payload),
									version: metadata.version,
									eventDate: metadata.eventId.yearMonth,
									eventId: metadata.eventId.value,
									aggregateId: metadata.aggregateId,
									occurredOn: metadata.occurredOn.getTime(),
									correlationId: metadata.correlationId,
									causationId: metadata.causationId,
								},
								{ removeUndefinedValues: true, convertClassInstanceToMap: true },
							),
							// Never overwrite an existing version of the stream
							ConditionExpression: 'attribute_not_exists(streamId)',
						},
					})),
				}),
			);

			return envelopes;
		} catch (error) {
			if (error instanceof EventStoreVersionConflictException) {
				throw error;
			}

			if (isConflictingTransaction(error)) {
				// A concurrent transaction might not be visible yet, in which case the version we tried to write is reported
				const currentVersion = await this.getCurrentVersion(collection, stream).catch(() => undefined);
				throw new EventStoreVersionConflictException(
					stream,
					aggregateVersion,
					currentVersion ?? aggregateVersion,
					error,
				);
			}

			throw new EventStorePersistenceException(collection, error);
		}
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);
		const { Item } = await this.client.send(
			new GetItemCommand({
				TableName: collection,
				Key: marshall({ streamId, version }, { removeUndefinedValues: true }),
				ProjectionExpression: 'event, payload, aggregateId, eventId, occurredOn, version, correlationId, causationId',
				ConsistentRead: true,
			}),
		);

		if (!Item) {
			throw new EventNotFoundException(streamId, version);
		}

		const entity =
			this.hydrate<
				['event', 'payload', 'aggregateId', 'eventId', 'occurredOn', 'version', 'correlationId', 'causationId']
			>(Item);

		return EventEnvelope.from(entity.event, entity.payload, {
			eventId: EventId.from(entity.eventId),
			aggregateId: entity.aggregateId,
			version: entity.version,
			occurredOn: new Date(entity.occurredOn),
			correlationId: entity.correlationId,
			causationId: entity.causationId,
		});
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['streamId = :streamId'];
		const ExpressionAttributeValues = {
			':streamId': { S: streamId },
		};

		if (fromVersion) {
			KeyConditionExpression.push('version >= :fromVersion');
			ExpressionAttributeValues[':fromVersion'] = { N: fromVersion.toString() };
		}

		const entities: EventEnvelope<IEvent>[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'event, payload, aggregateId, eventId, occurredOn, version, correlationId, causationId',
					ConsistentRead: true,
					...(direction === StreamReadingDirection.BACKWARD && { ScanIndexForward: false }),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			entities.push(
				...(Items || []).map((item) => {
					const entity =
						this.hydrate<
							['event', 'payload', 'aggregateId', 'eventId', 'occurredOn', 'version', 'correlationId', 'causationId']
						>(item);
					return EventEnvelope.from(entity.event, entity.payload, {
						eventId: EventId.from(entity.eventId),
						aggregateId: entity.aggregateId,
						version: entity.version,
						occurredOn: new Date(entity.occurredOn),
						correlationId: entity.correlationId,
						causationId: entity.causationId,
					});
				}),
			);
			leftToFetch -= Items?.length || 0;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	async *getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		const yearMonths = this.getYearMonthRange(filter.since, filter.until);

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const entities: EventEnvelope<IEvent>[] = [];
		let monthsFetched = 0;
		let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					IndexName: 'eventIdIndex',
					KeyConditionExpression: 'eventDate = :yearMonth',
					ExclusiveStartKey,
					ExpressionAttributeValues: {
						':yearMonth': { S: yearMonths[monthsFetched] },
					},
					ProjectionExpression: 'event, payload, aggregateId, eventId, occurredOn, version, correlationId, causationId',
					...(batch && { Limit: batch }),
				}),
			);

			entities.push(
				...(Items || []).map((item) => {
					const entity =
						this.hydrate<
							['event', 'payload', 'aggregateId', 'eventId', 'occurredOn', 'version', 'correlationId', 'causationId']
						>(item);
					return EventEnvelope.from(entity.event, entity.payload, {
						eventId: EventId.from(entity.eventId),
						aggregateId: entity.aggregateId,
						version: entity.version,
						occurredOn: new Date(entity.occurredOn),
						correlationId: entity.correlationId,
						causationId: entity.causationId,
					});
				}),
			);
			ExclusiveStartKey = LastEvaluatedKey;
			if (!LastEvaluatedKey) {
				monthsFetched++;
			}

			if (entities.length > 0) {
				yield entities;
				entities.length = 0;
			}
		} while (monthsFetched < yearMonths.length);
	}

	/**
	 * Returns the version of the last event in a stream (strongly consistent), or undefined for an empty stream.
	 */
	private async getCurrentVersion(
		collection: IEventCollection,
		{ streamId }: EventStream,
	): Promise<number | undefined> {
		const { Items } = await this.client.send(
			new QueryCommand({
				TableName: collection,
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: streamId },
				},
				ProjectionExpression: 'version',
				ConsistentRead: true,
				ScanIndexForward: false, // Sort by RANGE key in descending order (highest value first)
				Limit: 1, // Limit to 1 item (the highest version)
			}),
		);

		return Items?.[0] ? this.hydrate<['version']>(Items[0]).version : undefined;
	}

	hydrate<Fields extends (keyof DynamoEventEntity)[]>(
		entity: Record<string, AttributeValue>,
	): Pick<DynamoEventEntity, Fields[number]> {
		return unmarshall(entity) as Pick<DynamoEventEntity, Fields[number]>;
	}
}
