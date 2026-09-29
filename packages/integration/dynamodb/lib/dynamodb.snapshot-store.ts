import { randomUUID } from 'node:crypto';
import {
	type AttributeValue,
	type CreateTableCommandInput,
	DynamoDBClient,
	GetItemCommand,
	ListTablesCommand,
	QueryCommand,
	type TransactWriteItem,
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
import { ensureTable, isConflictingTransaction, normalizePayload } from './helpers/index.js';
import type { DynamoDBSnapshotStoreConfig, DynamoSnapshotEntity } from './interfaces/index.js';

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
				},
				config,
			);

			return collection;
		} catch (err) {
			throw new SnapshotStoreCollectionCreationException(collection, err);
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const entities: ISnapshotCollection[] = [];
		let ExclusiveStartTableName: string | undefined;
		do {
			const { TableNames, LastEvaluatedTableName } = await this.client.send(
				new ListTablesCommand({
					ExclusiveStartTableName,
					Limit: batch,
				}),
			);

			ExclusiveStartTableName = LastEvaluatedTableName;
			entities.push(...((TableNames || []).filter((name) => name.endsWith('snapshots')) as ISnapshotCollection[]));

			if (entities.length > 0) {
				// Hand out the buffered items in a new array, so a batch the consumer holds on to never changes
				yield entities.splice(0);
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
		let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'payload',
					ConsistentRead: true,
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;

			if (Items) {
				for (const item of Items) {
					const { payload } = this.hydrate<A, ['payload']>(item);
					entities.push(payload);
				}
			}

			leftToFetch -= Items?.length || 0;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				// Hand out the buffered items in a new array, so a batch the consumer holds on to never changes
				yield entities.splice(0);
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
				ConsistentRead: true,
			}),
		);

		if (!Item) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		const { payload } = this.hydrate<A, ['payload']>(Item);

		return payload;
	}

	/**
	 * Appends a snapshot in a single DynamoDB transaction that also moves the 'latest' marker from the previous
	 * snapshot of the stream. The snapshot is written with a condition on its (streamId, version) key and the marker
	 * is only removed while the previous snapshot still holds it, so an existing snapshot is never overwritten and
	 * concurrent appends to the same stream raise a SnapshotStoreVersionConflictException instead of both succeeding.
	 * Transactional writes consume twice the write capacity of regular writes.
	 */
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

			const lastStreamEntity = await this.getLastStreamEntity<A>(collection, stream);

			if (lastStreamEntity && aggregateVersion <= lastStreamEntity.version) {
				throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, lastStreamEntity.version);
			}

			// Without a previous snapshot there is no item to guard, so only snapshots of the same version conflict then
			const updateLastItem: TransactWriteItem[] = [];
			if (lastStreamEntity?.latest) {
				updateLastItem.push({
					Update: {
						TableName: collection,
						Key: marshall(
							{ streamId: stream.streamId, version: lastStreamEntity.version },
							{ removeUndefinedValues: true },
						),
						UpdateExpression: 'REMOVE latest',
						// Fails when a concurrent append already moved the 'latest' marker
						ConditionExpression: 'latest = :latest',
						ExpressionAttributeValues: { ':latest': { S: lastStreamEntity.latest } },
					},
				});
			}

			await this.client.send(
				new TransactWriteItemsCommand({
					// Makes retries of a transaction that was already applied idempotent (for 10 minutes)
					ClientRequestToken: randomUUID(),
					TransactItems: [
						...updateLastItem,
						{
							Put: {
								TableName: collection,
								Item: marshall(
									{
										streamId: stream.streamId,
										payload: normalizePayload(envelope.payload),
										version: envelope.metadata.version,
										aggregateName: stream.aggregate,
										snapshotId: envelope.metadata.snapshotId,
										aggregateId: envelope.metadata.aggregateId,
										registeredOn: envelope.metadata.registeredOn.getTime(),
										latest: `latest#${stream.streamId}`,
									},
									{ removeUndefinedValues: true, convertClassInstanceToMap: true },
								),
								// Never overwrite an existing version of the stream
								ConditionExpression: 'attribute_not_exists(streamId)',
							},
						},
					],
				}),
			);

			return envelope;
		} catch (error) {
			if (error instanceof SnapshotStoreVersionConflictException) {
				throw error;
			}

			if (isConflictingTransaction(error)) {
				// A concurrent transaction might not be visible yet, in which case the version we tried to write is reported
				const lastStreamEntity = await this.getLastStreamEntity<A>(collection, stream).catch(() => undefined);
				throw new SnapshotStoreVersionConflictException(
					stream,
					aggregateVersion,
					lastStreamEntity?.version ?? aggregateVersion,
					error,
				);
			}

			throw new SnapshotStorePersistenceException(collection, error);
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void> {
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
				ConsistentRead: true,
			}),
		);

		if (Items?.[0]) {
			const { payload } = this.hydrate<A, ['payload']>(Items[0]);

			return payload;
		}
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<A, ['streamId', 'payload']>(collection, streams, [
			'streamId',
			'payload',
		]);

		return entities.reduce((acc, { streamId, payload }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId);

			if (stream) {
				acc.set(stream, payload);
			}

			return acc;
		}, new Map<SnapshotStream, ISnapshot<A>>());
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
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
		let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
		do {
			const { Items, LastEvaluatedKey } = await this.client.send(
				new QueryCommand({
					TableName: collection,
					KeyConditionExpression: KeyConditionExpression.join(' AND '),
					ExclusiveStartKey,
					ExpressionAttributeValues,
					ProjectionExpression: 'payload, snapshotId, aggregateId, registeredOn, version',
					ConsistentRead: true,
					...(direction === StreamReadingDirection.BACKWARD && {
						ScanIndexForward: false,
					}),
					...(limit && { Limit: Math.min(batch, leftToFetch) }),
				}),
			);

			ExclusiveStartKey = LastEvaluatedKey;

			if (Items) {
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
			}

			leftToFetch -= Items?.length || 0;

			if (envelopes.length > 0 && (envelopes.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				// Hand out the buffered items in a new array, so a batch the consumer holds on to never changes
				yield envelopes.splice(0);
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
				ConsistentRead: true,
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

		if (!streamName) {
			return [];
		}

		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const KeyConditionExpression = ['aggregateName = :aggregateName'];
		const ExpressionAttributeValues = { ':aggregateName': { S: streamName } };

		if (aggregateId) {
			KeyConditionExpression.push('latest > :latest');
			ExpressionAttributeValues[':latest'] = { S: `latest#${aggregateId}` };
		} else {
			KeyConditionExpression.push('begins_with(latest, :latest)');
			ExpressionAttributeValues[':latest'] = { S: 'latest' };
		}

		const entities: SnapshotEnvelope<A>[] = [];
		let leftToFetch = limit;
		let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
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

			if (Items) {
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
			}

			leftToFetch -= Items?.length || 0;

			if (entities.length > 0 && (entities.length === batch || !ExclusiveStartKey || leftToFetch <= 0)) {
				// Hand out the buffered items in a new array, so a batch the consumer holds on to never changes
				yield entities.splice(0);
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

		return entities.reduce((acc, { streamId, payload, aggregateId, registeredOn, snapshotId, version }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId);

			if (stream) {
				acc.set(
					stream,
					SnapshotEnvelope.from<A>(payload, {
						aggregateId,
						registeredOn: new Date(registeredOn),
						snapshotId,
						version,
					}),
				);
			}

			return acc;
		}, new Map<SnapshotStream, SnapshotEnvelope<A>>());
	}

	hydrate<A extends AggregateRoot, Fields extends (keyof DynamoSnapshotEntity<A>)[]>(
		entity: Record<string, AttributeValue>,
	): Pick<DynamoSnapshotEntity<A>, Fields[number]> {
		return unmarshall(entity) as Pick<DynamoSnapshotEntity<A>, Fields[number]>;
	}

	/**
	 * Returns the version and 'latest' marker of the snapshot with the highest version in a stream (strongly consistent).
	 */
	private async getLastStreamEntity<A extends AggregateRoot>(
		collection: ISnapshotCollection,
		{ streamId }: SnapshotStream,
	): Promise<Pick<DynamoSnapshotEntity<A>, 'version' | 'latest'> | undefined> {
		const { Items } = await this.client.send(
			new QueryCommand({
				TableName: collection,
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: streamId },
				},
				ProjectionExpression: 'version, latest',
				ConsistentRead: true,
				ScanIndexForward: false,
				Limit: 1,
			}),
		);

		return Items?.[0] ? this.hydrate<A, ['version', 'latest']>(Items[0]) : undefined;
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

			return Items?.[0] ? this.hydrate<A, Fields>(Items[0]) : null;
		});

		const results = await Promise.all(items);

		return results.filter((result) => result !== null);
	}
}
