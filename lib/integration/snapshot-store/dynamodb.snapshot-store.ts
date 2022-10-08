import {
	AttributeValue,
	CreateTableCommand,
	DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool } from '../../interfaces';
import { AggregateRoot, SnapshotCollection, SnapshotEnvelope, SnapshotStream } from '../../models';
import { LatestSnapshotFilter, SnapshotFilter, SnapshotStore } from '../../snapshot-store';

export interface DynamoSnapshotEntity<A extends AggregateRoot> {
	streamId: string;
	version: number;
	payload: ISnapshot<A>;
	snapshotId: string;
	aggregateId: string;
	registeredOn: number;
}

export class DynamoDBSnapshotStore extends SnapshotStore {
	constructor(readonly client: DynamoDBClient) {
		super();
	}

	async setup(pool?: ISnapshotPool): Promise<SnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
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
					{ AttributeName: 'aggregateName', AttributeType: 'S' },
					{ AttributeName: 'latest', AttributeType: 'N' },
				],
				GlobalSecondaryIndexes: [
					{
						IndexName: 'aggregate_index',
						KeySchema: [
							{ AttributeName: 'aggregateName', KeyType: 'HASH' },
							{ AttributeName: 'latest', KeyType: 'RANGE' },
						],
						Projection: {
							ProjectionType: 'ALL',
						},
					},
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

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		let fromVersion = filter?.fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['streamId = :streamId'];
		const ExpressionAttributeValues = { ':streamId': { S: streamId } };

		if (fromVersion) {
			KeyConditionExpression.push('version >= :fromVersion');
			ExpressionAttributeValues[':fromVersion'] = { N: fromVersion.toString() };
		}

		const entities: ISnapshot<A>[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue>;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			Items.forEach((item) => entities.push(this.hydrate<A>(item).payload));
			leftToFetch -= Items.length;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);
		const { Item } = await this.client.send(
			new GetItemCommand({
				TableName: collection,
				Key: marshall({ streamId, version }),
			}),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		const { payload } = this.hydrate<A>(Item);

		return payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		{ streamId, aggregateId, aggregate }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<void> {
		const collection = SnapshotCollection.get(pool);

		const { payload, metadata } = SnapshotEnvelope.create<A>(snapshot, {
			aggregateId,
			version: aggregateVersion,
		});

		const updateLastItem = [];
		const lastStreamEntity = await this.getLastStreamEntity(collection, streamId);

		if (lastStreamEntity) {
			const snapshot = this.hydrate<A>(lastStreamEntity);
			updateLastItem.push({
				Update: {
					TableName: collection,
					Key: marshall({ streamId, version: snapshot.version }),
					UpdateExpression: 'SET latest = :latest',
					ExpressionAttributeValues: { ':latest': { N: 0 } },
				},
			});
		}

		await this.client.send(
			new TransactWriteItemsCommand({
				TransactItems: [
					...updateLastItem,
					{
						Put: {
							TableName: collection,
							Item: marshall({
								streamId,
								payload,
								version: metadata.version,
								aggregateName: aggregate,
								snapshotId: metadata.snapshotId,
								aggregateId: metadata.aggregateId,
								registeredOn: metadata.registeredOn.getTime(),
								latest: 1,
							}),
						},
					},
				],
			}),
		);
	}

	async getLastSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);
		const { Items } = await this.client.send(
			new QueryCommand({
				TableName: collection,
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: streamId },
				},
				ScanIndexForward: false,
				Limit: 1,
			}),
		);

		if (Items[0]) {
			const { payload } = unmarshall(Items[0]);

			return payload;
		}
	}

	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const lastSnapshotEntity = await this.getLastStreamEntity<A>(collection, streamId);

		if (lastSnapshotEntity) {
			return this.hydrateEnvelope(lastSnapshotEntity);
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		let fromVersion = filter?.fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['streamId = :streamId'];
		const ExpressionAttributeValues = {
			':streamId': { S: streamId },
		};

		if (fromVersion) {
			KeyConditionExpression.push('version >= :fromVersion');
			ExpressionAttributeValues[':fromVersion'] = { N: fromVersion.toString() };
		}

		const entities: SnapshotEnvelope<A>[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue>;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			Items.forEach((item) => entities.push(this.hydrateEnvelope(item)));
			leftToFetch -= Items.length;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const { Item } = await this.client.send(
			new GetItemCommand({
				TableName: collection,
				Key: marshall({ streamId, version }),
			}),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return this.hydrateEnvelope(Item);
	}

	async *getLastEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(pool);

		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['aggregateName = :aggregateName', ' latest = :latest'];
		const ExpressionAttributeValues = {
			':aggregateName': { S: aggregateName },
			':latest': { N: '1' },
		};

		const entities: SnapshotEnvelope<A>[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue>;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					IndexName: 'aggregate_index',
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ScanIndexForward: false,
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			Items.forEach((item) => entities.push(this.hydrateEnvelope(item)));
			leftToFetch -= Items.length;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	hydrate<A extends AggregateRoot>(entity: Record<string, AttributeValue>): DynamoSnapshotEntity<A> {
		return unmarshall(entity) as DynamoSnapshotEntity<A>;
	}

	hydrateEnvelope<A extends AggregateRoot>(entity: Record<string, AttributeValue>): SnapshotEnvelope<A> {
		const parsed = this.hydrate<A>(entity);
		return SnapshotEnvelope.from<A>(parsed.payload, {
			snapshotId: parsed.snapshotId,
			aggregateId: parsed.aggregateId,
			registeredOn: new Date(parsed.registeredOn),
			version: parsed.version,
		});
	}

	private async getLastStreamEntity<A extends AggregateRoot>(
		collection: string,
		streamId: string,
	): Promise<Record<string, AttributeValue>> {
		const { Items } = await this.client.send(
			new QueryCommand({
				TableName: collection,
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: streamId },
				},
				ScanIndexForward: false,
				Limit: 1,
			}),
		);

		return Items.pop();
	}
}
