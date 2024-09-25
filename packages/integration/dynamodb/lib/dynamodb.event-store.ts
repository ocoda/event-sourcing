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
	QueryCommand,
	ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventEnvelope,
	EventNotFoundException,
	EventStore,
	EventStorePersistenceException,
	type EventStream,
	type IEvent,
	type IEventCollection,
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
					throw err;
			}
		}
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
		{ streamId, aggregateId }: EventStream,
		aggregateVersion: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		try {
			let version = aggregateVersion - events.length + 1;

			const envelopes: EventEnvelope[] = [];
			for (const event of events) {
				const name = this.eventMap.getName(event);
				const payload = this.eventMap.serializeEvent(event);
				const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
				envelopes.push(envelope);
			}

			const params: BatchWriteItemInput = {
				RequestItems: {
					[collection]: envelopes.map(({ event, payload, metadata }) => ({
						PutRequest: {
							Item: marshall(
								{
									streamId,
									event,
									payload,
									version: metadata.version,
									eventId: metadata.eventId,
									aggregateId: metadata.aggregateId,
									occurredOn: metadata.occurredOn.getTime(),
									correlationId: metadata.correlationId,
									causationId: metadata.causationId,
								},
								{ removeUndefinedValues: true },
							),
						},
					})),
				},
			};

			await this.client.send(new BatchWriteItemCommand(params));

			return envelopes;
		} catch (error) {
			throw new EventStorePersistenceException(collection, error);
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
						eventId: entity.eventId,
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
			eventId: entity.eventId,
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
