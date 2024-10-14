import {
	type AttributeValue,
	BatchWriteItemCommand,
	type BatchWriteItemInput,
	BillingMode,
	CreateTableCommand,
	type CreateTableCommandInput,
	DescribeTableCommand,
	DynamoDBClient,
	GetItemCommand,
	ListTablesCommand,
	QueryCommand,
	ResourceNotFoundException,
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
	type IEvent,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventFilter,
	type IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import type { DynamoDBEventStoreConfig, DynamoEventEntity } from './interfaces';

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
			await this.client.send(new DescribeTableCommand({ TableName: collection }));
			return collection;
		} catch (err) {
			switch (err.constructor) {
				case ResourceNotFoundException:
					await this.client.send(
						new CreateTableCommand({
							TableName: collection,
							KeySchema: [
								{ AttributeName: 'streamId', KeyType: 'HASH' },
								{ AttributeName: 'version', KeyType: 'RANGE' },
							],
							AttributeDefinitions: [
								{ AttributeName: 'streamId', AttributeType: 'S' },
								{ AttributeName: 'version', AttributeType: 'N' },
							],
							ProvisionedThroughput: config?.ProvisionedThroughput || {
								ReadCapacityUnits: 1,
								WriteCapacityUnits: 1,
							},
							OnDemandThroughput: config?.OnDemandThroughput,
							BillingMode: config?.BillingMode || BillingMode.PAY_PER_REQUEST,
						}),
					);
					break;
				default:
					throw new EventStoreCollectionCreationException(collection, err);
			}
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const entities = [];
		let ExclusiveStartTableName: string;
		do {
			const { TableNames, LastEvaluatedTableName } = await this.client.send(
				new ListTablesCommand({
					ExclusiveStartTableName,
					Limit: batch,
				}),
			);

			ExclusiveStartTableName = LastEvaluatedTableName;
			entities.push(...TableNames.filter((name) => name.endsWith('events')));

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

		const entities = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue>;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'event, payload',
					...(direction === StreamReadingDirection.BACKWARD && { ScanIndexForward: false }),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			entities.push(
				...Items.map((item) => {
					const entity = this.hydrate<['event', 'payload']>(item);
					return this.eventMap.deserializeEvent(entity.event, entity.payload);
				}),
			);
			leftToFetch -= Items.length;

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
			}),
		);

		if (!Item) {
			throw new EventNotFoundException(streamId, version);
		}

		const entity = this.hydrate<['event', 'payload']>(Item);

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	async appendEvents(
		stream: EventStream,
		aggregateVersion: number,
		events: IEvent[] | EventEnvelope[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		try {
			if (aggregateVersion > 1) {
				const { Items } = await this.client.send(
					new QueryCommand({
						TableName: collection,
						KeyConditionExpression: 'streamId = :streamId',
						ExpressionAttributeValues: {
							':streamId': { S: stream.streamId },
						},
						ScanIndexForward: false, // Sort by RANGE key in descending order (highest value first)
						Limit: 1, // Limit to 1 item (the highest version)
					}),
				);

				if (Items.length > 0 && unmarshall(Items[0]).version >= aggregateVersion) {
					throw new EventStoreVersionConflictException(stream, aggregateVersion, unmarshall(Items[0]).version);
				}
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

			const params: BatchWriteItemInput = {
				RequestItems: {
					[collection]: envelopes.map(({ event, payload, metadata }) => ({
						PutRequest: {
							Item: marshall(
								{
									streamId: stream.streamId,
									event,
									payload,
									version: metadata.version,
									eventId: metadata.eventId.value,
									aggregateId: metadata.aggregateId,
									occurredOn: metadata.occurredOn.getTime(),
									correlationId: metadata.correlationId,
									causationId: metadata.causationId,
								},
								{ removeUndefinedValues: true, convertClassInstanceToMap: true },
							),
						},
					})),
				},
			};

			await this.client.send(new BatchWriteItemCommand(params));

			return envelopes;
		} catch (error) {
			switch (error.constructor) {
				case EventStoreVersionConflictException:
					throw error;
				default:
					throw new EventStorePersistenceException(collection, error);
			}
		}
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

		const entities = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue>;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'event, payload, aggregateId, eventId, occurredOn, version, correlationId, causationId',
					...(direction === StreamReadingDirection.BACKWARD && { ScanIndexForward: false }),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			entities.push(
				...Items.map((item) => {
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
			leftToFetch -= Items.length;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);
		const { Item } = await this.client.send(
			new GetItemCommand({
				TableName: collection,
				Key: marshall({ streamId, version }, { removeUndefinedValues: true }),
				ProjectionExpression: 'event, payload, aggregateId, eventId, occurredOn, version, correlationId, causationId',
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

	hydrate<Fields extends (keyof DynamoEventEntity)[]>(
		entity: Record<string, AttributeValue>,
	): Pick<DynamoEventEntity, Fields[number]> {
		return unmarshall(entity) as Pick<DynamoEventEntity, Fields[number]>;
	}
}
