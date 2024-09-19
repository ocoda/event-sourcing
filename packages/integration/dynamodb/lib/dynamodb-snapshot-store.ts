import {
	AttributeValue,
	BillingMode,
	CreateTableCommand,
	CreateTableCommandInput,
	DescribeTableCommand,
	DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	ResourceNotFoundException,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
	AggregateRoot,
	DEFAULT_BATCH_SIZE,
	ISnapshot,
	ISnapshotCollection,
	ISnapshotPool,
	LatestSnapshotFilter,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotFilter,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStorePersistenceException,
	SnapshotStream,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { DynamoDBSnapshotStoreConfig, DynamoSnapshotEntity } from './interfaces';

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
					throw err;
			}
		}
	}

	public async stop(): Promise<void> {
		void this.client.destroy();
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
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
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			for (const item of Items) {
				entities.push(this.hydrate<A>(item).payload);
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
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		try {
			const envelope = SnapshotEnvelope.create<A>(snapshot, {
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
								Item: marshall({
									streamId,
									payload: envelope.payload,
									version: envelope.metadata.version,
									aggregateName: aggregate,
									snapshotId: envelope.metadata.snapshotId,
									aggregateId: envelope.metadata.aggregateId,
									registeredOn: envelope.metadata.registeredOn.getTime(),
									latest: `latest#${streamId}`,
								}),
							},
						},
					],
				}),
			);

			return envelope;
		} catch (error) {
			throw new SnapshotStorePersistenceException(collection, error);
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
			for (const item of Items) {
				entities.push(this.hydrateEnvelope(item));
			}
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
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['aggregateName = :aggregateName'];
		const ExpressionAttributeValues = { ':aggregateName': { S: aggregateName } };

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
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;
			for (const item of Items) {
				entities.push(this.hydrateEnvelope(item));
			}
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
