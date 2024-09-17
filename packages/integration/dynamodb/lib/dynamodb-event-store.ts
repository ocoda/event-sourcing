import {
	AttributeValue,
	BatchWriteItemCommand,
	BatchWriteItemInput,
	CreateTableCommand,
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
	EventFilter,
	EventNotFoundException,
	EventStore,
	EventStream,
	IEvent,
	IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { DynamoDBEventStoreConfig, DynamoEventEntity } from './interfaces';

export class DynamoDBEventStore extends EventStore<DynamoDBEventStoreConfig> {
	private client: DynamoDBClient;

	public async start(): Promise<void> {
		this.logger.log('Starting store');
		const { pool, ...params } = this.options;

		this.client = new DynamoDBClient(params);

		const collection = EventCollection.get(pool);

		try {
			await this.client.send(new DescribeTableCommand({ TableName: collection }));
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
							ProvisionedThroughput: {
								ReadCapacityUnits: 1,
								WriteCapacityUnits: 1,
							},
							BillingMode: 'PAY_PER_REQUEST',
						}),
					);
					break;
				default:
					throw err;
			}
		}
	}

	public stop(): void {
		this.client.destroy();
	}

	async *getEvents({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]> {
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
					...(direction === StreamReadingDirection.BACKWARD && { ScanIndexForward: false }),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			entities.push(
				...Items.map((item) => {
					const { event, payload } = unmarshall(item);
					return this.eventMap.deserializeEvent(event, payload);
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
			new GetItemCommand({ TableName: collection, Key: marshall({ streamId, version }) }),
		);

		if (!Item) {
			throw new EventNotFoundException(streamId, version);
		}

		const { event, payload } = unmarshall(Item);

		return this.eventMap.deserializeEvent(event, payload);
	}

	async appendEvents(
		{ streamId, aggregateId }: EventStream,
		aggregateVersion: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

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
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
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
					...(direction === StreamReadingDirection.BACKWARD && { ScanIndexForward: false }),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			entities.push(
				...Items.map((item) => {
					const { event, payload, aggregateId, eventId, occurredOn, version, correlationId, causationId } = unmarshall(
						item,
					) as DynamoEventEntity;
					return EventEnvelope.from(event, payload, {
						eventId: eventId,
						aggregateId,
						version,
						occurredOn: new Date(occurredOn),
						correlationId,
						causationId,
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
			new GetItemCommand({ TableName: collection, Key: marshall({ streamId, version }) }),
		);

		if (!Item) {
			throw new EventNotFoundException(streamId, version);
		}

		const { event, payload, aggregateId, eventId, occurredOn, correlationId, causationId } = unmarshall(
			Item,
		) as DynamoEventEntity;

		return EventEnvelope.from(event, payload, {
			eventId: eventId,
			aggregateId,
			version,
			occurredOn: new Date(occurredOn),
			correlationId,
			causationId,
		});
	}
}
