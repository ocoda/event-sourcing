import {
	type AttributeValue,
	BillingMode,
	CreateTableCommand,
	type CreateTableCommandInput,
	DescribeTableCommand,
	DynamoDBClient,
	GetItemCommand,
	ListTablesCommand,
	QueryCommand,
	ResourceNotFoundException,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { Type } from '@nestjs/common';
import {
	type AggregateRoot,
	DEFAULT_BATCH_SIZE,
	type ILatestSnapshotFilter,
	type ISnapshot,
	type ISnapshotCollection,
	type ISnapshotCollectionFilter,
	type ISnapshotFilter,
	type ISnapshotPool,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	type SnapshotStream,
	StreamReadingDirection,
	getAggregateMetadata,
} from '@ocoda/event-sourcing';
import type { DynamoDBSnapshotStoreConfig, DynamoSnapshotEntity } from './interfaces';

export class DynamoDBSnapshotStore extends SnapshotStore<DynamoDBSnapshotStoreConfig> {
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
		pool?: ISnapshotPool,
		config?: Pick<CreateTableCommandInput, 'BillingMode' | 'ProvisionedThroughput' | 'OnDemandThroughput'>,
	): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

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
								{ AttributeName: 'aggregateName', AttributeType: 'S' },
								{ AttributeName: 'latest', AttributeType: 'S' },
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
					throw new SnapshotStoreCollectionCreationException(collection, err);
			}
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
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
			entities.push(...TableNames.filter((name) => name.endsWith('snapshots')));

			if (entities.length > 0 && !ExclusiveStartTableName) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartTableName);
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

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
					ProjectionExpression: 'payload',
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			for (const item of Items) {
				const { payload } = this.hydrate<A, ['payload']>(item);
				entities.push(payload);
			}
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
				Key: marshall({ streamId, version }, { removeUndefinedValues: true }),
				ProjectionExpression: 'payload',
			}),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		const { payload } = this.hydrate<A, ['payload']>(Item);

		return payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		try {
			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			const updateLastItem = [];
			const [lastStreamEntity] = await this.getLastStreamEntities<A, ['version']>(collection, [stream], ['version']);

			if (aggregateVersion <= lastStreamEntity?.version) {
				throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, lastStreamEntity.version);
			}

			if (lastStreamEntity) {
				updateLastItem.push({
					Update: {
						TableName: collection,
						Key: marshall(
							{ streamId: stream.streamId, version: lastStreamEntity.version },
							{ removeUndefinedValues: true },
						),
						UpdateExpression: 'REMOVE latest',
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
								Item: marshall(
									{
										streamId: stream.streamId,
										payload: envelope.payload,
										version: envelope.metadata.version,
										aggregateName: stream.aggregate,
										snapshotId: envelope.metadata.snapshotId,
										aggregateId: envelope.metadata.aggregateId,
										registeredOn: envelope.metadata.registeredOn.getTime(),
										latest: `latest#${stream.streamId}`,
									},
									{ removeUndefinedValues: true, convertClassInstanceToMap: true },
								),
							},
						},
					],
				}),
			);

			return envelope;
		} catch (error) {
			switch (error.constructor) {
				case SnapshotStoreVersionConflictException:
					throw error;
				default:
					throw new SnapshotStorePersistenceException(collection, error);
			}
		}
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
				ProjectionExpression: 'payload',
			}),
		);

		if (Items[0]) {
			const { payload } = this.hydrate<A, ['payload']>(Items[0]);

			return payload;
		}
	}

	async getManyLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<A, ['streamId', 'payload']>(collection, streams, [
			'streamId',
			'payload',
		]);

		return new Map(
			entities.map(({ streamId, payload }) => [
				streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId),
				payload,
			]),
		);
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const [lastSnapshotEntity] = await this.getLastStreamEntities<
			A,
			['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']
		>(collection, [stream], ['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']);

		if (lastSnapshotEntity) {
			return SnapshotEnvelope.from<A>(lastSnapshotEntity.payload, {
				snapshotId: lastSnapshotEntity.snapshotId,
				aggregateId: lastSnapshotEntity.aggregateId,
				registeredOn: new Date(lastSnapshotEntity.registeredOn),
				version: lastSnapshotEntity.version,
			});
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

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

		const envelopes: SnapshotEnvelope<A>[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue>;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'payload, snapshotId, aggregateId, registeredOn, version',
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			for (const item of Items) {
				const entity = this.hydrate<A, ['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']>(item);
				envelopes.push(
					SnapshotEnvelope.from<A>(entity.payload, {
						snapshotId: entity.snapshotId,
						aggregateId: entity.aggregateId,
						registeredOn: new Date(entity.registeredOn),
						version: entity.version,
					}),
				);
			}
			leftToFetch -= Items.length;

			if (envelopes.length > 0 && (envelopes.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield envelopes;
				envelopes.length = 0;
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
				Key: marshall({ streamId, version }, { removeUndefinedValues: true }),
				ProjectionExpression: 'payload, snapshotId, aggregateId, registeredOn, version',
			}),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		const entity = this.hydrate<A, ['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']>(Item);

		return SnapshotEnvelope.from<A>(entity.payload, {
			snapshotId: entity.snapshotId,
			aggregateId: entity.aggregateId,
			registeredOn: new Date(entity.registeredOn),
			version: entity.version,
		});
	}

	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);
		const { streamName } = getAggregateMetadata(aggregate);

		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['aggregateName = :aggregateName'];
		const ExpressionAttributeValues = { ':aggregateName': { S: streamName } };

		if (fromId) {
			KeyConditionExpression.push('latest > :latest');
			ExpressionAttributeValues[':latest'] = { S: `latest#${fromId}` };
		} else {
			KeyConditionExpression.push('begins_with(latest, :latest)');
			ExpressionAttributeValues[':latest'] = { S: 'latest' };
		}

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
					ProjectionExpression: 'payload, snapshotId, aggregateId, registeredOn, version',
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			for (const item of Items) {
				const entity = this.hydrate<A, ['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']>(item);
				entities.push(
					SnapshotEnvelope.from<A>(entity.payload, {
						snapshotId: entity.snapshotId,
						aggregateId: entity.aggregateId,
						registeredOn: new Date(entity.registeredOn),
						version: entity.version,
					}),
				);
			}
			leftToFetch -= Items.length;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				yield entities;
				entities.length = 0;
			}
		} while (ExclusiveStartKey && leftToFetch > 0);
	}

	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<
			A,
			['streamId', 'payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']
		>(collection, streams, ['streamId', 'payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']);

		return new Map(
			entities.map(({ streamId, payload, aggregateId, registeredOn, snapshotId, version }) => [
				streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId),
				SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn: new Date(registeredOn), snapshotId, version }),
			]),
		);
	}

	hydrate<A extends AggregateRoot, Fields extends (keyof DynamoSnapshotEntity<A>)[]>(
		entity: Record<string, AttributeValue>,
	): Pick<DynamoSnapshotEntity<A>, Fields[number]> {
		return unmarshall(entity) as Pick<DynamoSnapshotEntity<A>, Fields[number]>;
	}

	private async getLastStreamEntities<
		A extends AggregateRoot,
		Fields extends (keyof DynamoSnapshotEntity<A>)[] = (keyof DynamoSnapshotEntity<A>)[],
	>(
		collection: string,
		streams: SnapshotStream[],
		fields: Fields,
	): Promise<Pick<DynamoSnapshotEntity<A>, Fields[number]>[]> {
		const items = streams.map(async ({ aggregate, streamId }) => {
			const { Items } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					IndexName: 'aggregate_index', // Specify the GSI name
					KeyConditionExpression: 'aggregateName = :aggregateName AND latest = :latest',
					ExpressionAttributeValues: {
						':aggregateName': { S: aggregate },
						':latest': { S: `latest#${streamId}` },
					},
					ProjectionExpression: fields.join(', '),
					ScanIndexForward: false, // Get the latest item by sorting descending on the RANGE key
					Limit: 1, // Limit to the latest snapshot
				}),
			);

			return Items[0] ? this.hydrate<A, Fields>(Items[0]) : null;
		});

		return Promise.all(items);
	}
}
