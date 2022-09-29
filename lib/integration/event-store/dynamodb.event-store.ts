import {
	AttributeValue,
	BatchWriteItemCommand,
	BatchWriteItemInput,
	CreateTableCommand,
	DynamoDBClient,
	GetItemCommand,
	QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore, StreamEventFilter } from '../../event-store';
import { EventNotFoundException } from '../../exceptions';
import { IEvent, IEventPool } from '../../interfaces';
import { EventCollection, EventEnvelope, EventStream } from '../../models';

export interface DynamoEventEntity {
	streamId: string;
	version: number;
	event: string;
	payload: any;
	eventId: string;
	aggregateId: string;
	occurredOn: number;
	correlationId?: string;
	causationId?: string;
}

export class DynamoDbEventStore extends EventStore {
	constructor(readonly eventMap: EventMap, readonly client: DynamoDBClient) {
		super();
	}

	async setup(pool?: IEventPool): Promise<EventCollection> {
		const collection = EventCollection.get(pool);
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

		return collection;
	}

	async *getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);
		let eventStream = filter?.eventStream;
		let fromVersion = eventStream && (filter as StreamEventFilter).fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = [];
		const ExpressionAttributeValues = {};

		if (eventStream) {
			KeyConditionExpression.push('streamId = :streamId');
			ExpressionAttributeValues[':streamId'] = { S: filter.eventStream.streamId };
		}

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
	): Promise<void> {
		const collection = EventCollection.get(pool);

		let version = aggregateVersion - events.length + 1;

		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			return [...acc, envelope];
		}, []);

		const params: BatchWriteItemInput = {
			RequestItems: {
				[collection]: envelopes.map(
					({ event, payload, metadata }) => ({
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
					}),
				),
			},
		};

		await this.client.send(new BatchWriteItemCommand(params));
	}

	async *getEnvelopes(filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		let eventStream = filter?.eventStream;
		let fromVersion = eventStream && (filter as StreamEventFilter).fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = [];
		const ExpressionAttributeValues = {};

		if (eventStream) {
			KeyConditionExpression.push('streamId = :streamId');
			ExpressionAttributeValues[':streamId'] = { S: filter.eventStream.streamId };
		}

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
