import {
	type AttributeValue,
	BillingMode,
	CreateTableCommand,
	type CreateTableCommandInput,
	DescribeTableCommand,
	DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	ResourceNotFoundException,
	TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
	type AggregateRoot,
	DEFAULT_BATCH_SIZE,
	type ILatestSnapshotFilter,
	type ISnapshot,
	type ISnapshotCollection,
	type ISnapshotFilter,
	type ISnapshotPool,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStorePersistenceException,
	type SnapshotStream,
	StreamReadingDirection,
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
					throw err;
			}
		}
	}

	public async stop(): Promise<void> {
		void this.client.destroy();
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
			const lastStreamEntity = await this.getLastStreamEntity(collection, streamId, ['version']);

			if (lastStreamEntity) {
				updateLastItem.push({
					Update: {
						TableName: collection,
						Key: marshall({ streamId, version: lastStreamEntity.version }, { removeUndefinedValues: true }),
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
										streamId,
										payload: envelope.payload,
										version: envelope.metadata.version,
										aggregateName: aggregate,
										snapshotId: envelope.metadata.snapshotId,
										aggregateId: envelope.metadata.aggregateId,
										registeredOn: envelope.metadata.registeredOn.getTime(),
										latest: `latest#${streamId}`,
									},
									{ removeUndefinedValues: true },
								),
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
				ProjectionExpression: 'payload',
			}),
		);

		if (Items[0]) {
			const { payload } = this.hydrate<A, ['payload']>(Items[0]);

			return payload;
		}
	}

	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const lastSnapshotEntity = await this.getLastStreamEntity<A>(collection, streamId, [
			'payload',
			'snapshotId',
			'aggregateId',
			'registeredOn',
			'version',
		]);

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

	async *getLastEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: ILatestSnapshotFilter,
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

	hydrate<A extends AggregateRoot, Fields extends (keyof DynamoSnapshotEntity<A>)[]>(
		entity: Record<string, AttributeValue>,
	): Pick<DynamoSnapshotEntity<A>, Fields[number]> {
		return unmarshall(entity) as Pick<DynamoSnapshotEntity<A>, Fields[number]>;
	}

	private async getLastStreamEntity<
		A extends AggregateRoot,
		Fields extends (keyof DynamoSnapshotEntity<A>)[] = (keyof DynamoSnapshotEntity<A>)[],
	>(collection: string, streamId: string, fields: Fields): Promise<Pick<DynamoSnapshotEntity<A>, Fields[number]>> {
		const { Items } = await this.client.send(
			new QueryCommand({
				TableName: collection,
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: streamId },
				},
				ProjectionExpression: fields.join(', '),
				ScanIndexForward: false,
				Limit: 1,
			}),
		);

		return Items[0] && this.hydrate<A, Fields>(Items[0]);
	}
}
