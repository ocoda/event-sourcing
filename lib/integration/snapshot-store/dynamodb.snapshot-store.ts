import {
	AttributeValue,
	CreateTableCommand,
	DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	PutItemInput,
	QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool } from '../../interfaces';
import { AggregateRoot, SnapshotCollection, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotFilter, SnapshotStore, StreamSnapshotFilter } from '../../snapshot-store';

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

	async *getSnapshots<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);
		let snapshotStream = filter?.snapshotStream;
		let fromVersion = snapshotStream && (filter as StreamSnapshotFilter).fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = [];
		const ExpressionAttributeValues = {};

		if (snapshotStream) {
			KeyConditionExpression.push('streamId = :streamId');
			ExpressionAttributeValues[':streamId'] = { S: snapshotStream.streamId };
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
					const { payload } = unmarshall(item);
					return payload;
				}),
			);
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
			new GetItemCommand({ TableName: collection, Key: marshall({ streamId, version }) }),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		const { payload } = unmarshall(Item);

		return payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		{ streamId, aggregateId }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<void> {
		const collection = SnapshotCollection.get(pool);

		const { payload, metadata } = SnapshotEnvelope.create<A>(snapshot, {
			aggregateId,
			version: aggregateVersion,
		});

		const params: PutItemInput = {
			TableName: collection,
			Item: marshall({
				streamId,
				payload,
				version: metadata.version,
				snapshotId: metadata.snapshotId,
				aggregateId: metadata.aggregateId,
				registeredOn: metadata.registeredOn.getTime(),
			}),
		};

		await this.client.send(new PutItemCommand(params));
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
		const { Items } = await this.client.send(
			new QueryCommand({
				TableName: collection,
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: streamId },
				},
				ScanIndexForward: false,
			}),
		);

		if (Items[0]) {
			const { payload, snapshotId, aggregateId, version, registeredOn } = unmarshall(
				Items[0],
			) as DynamoSnapshotEntity<A>;

			return SnapshotEnvelope.from<A>(payload, {
				snapshotId,
				aggregateId,
				registeredOn: new Date(registeredOn),
				version,
			});
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		let snapshotStream = filter?.snapshotStream;
		let fromVersion = snapshotStream && (filter as StreamSnapshotFilter).fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = [];
		const ExpressionAttributeValues = {};

		if (snapshotStream) {
			KeyConditionExpression.push('streamId = :streamId');
			ExpressionAttributeValues[':streamId'] = { S: snapshotStream.streamId };
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
					const { payload, snapshotId, aggregateId, version, registeredOn } = unmarshall(
						item,
					) as DynamoSnapshotEntity<A>;
					return SnapshotEnvelope.from<A>(payload, {
						snapshotId,
						aggregateId,
						registeredOn: new Date(registeredOn),
						version,
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

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const { Item } = await this.client.send(
			new GetItemCommand({ TableName: collection, Key: marshall({ streamId, version }) }),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		const { payload, snapshotId, aggregateId, registeredOn } = unmarshall(Item) as DynamoSnapshotEntity<A>;
		return SnapshotEnvelope.from<A>(payload, {
			snapshotId,
			aggregateId,
			registeredOn: new Date(registeredOn),
			version,
		});
	}
}
