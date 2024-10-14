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
import { type Pool, createPool } from 'mariadb';
import type { MariaDBEventEntity, MariaDBEventStoreConfig } from './interfaces';

export class MariaDBEventStore extends EventStore<MariaDBEventStoreConfig> {
	private pool: Pool;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = createPool(this.options);
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		await this.pool.end();
	}

	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);

		try {
			await this.pool.query(
				`CREATE TABLE IF NOT EXISTS \`${collection}\` (
                    stream_id VARCHAR(120) NOT NULL,
                    version INT NOT NULL,
                    event VARCHAR(80) NOT NULL,
                    payload JSON NOT NULL,
                    event_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    occurred_on TIMESTAMP NOT NULL,
                    correlation_id VARCHAR(255),
                    causation_id VARCHAR(255),
                    PRIMARY KEY (stream_id, version)
                )`,
			);

			return collection;
		} catch (error) {
			throw new EventStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const connection = this.pool.getConnection();

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = "SELECT TABLE_NAME FROM information_schema.tables WHERE BINARY table_name LIKE '%events'";

		const client = await connection;
		const stream = client.queryStream(query);

		try {
			let batchedCollections: IEventCollection[] = [];
			for await (const { TABLE_NAME } of stream as unknown as Record<string, IEventCollection>[]) {
				batchedCollections.push(TABLE_NAME);
				if (batchedCollections.length === batch) {
					yield batchedCollections;
					batchedCollections = [];
				}
			}
			if (batchedCollections.length > 0) {
				yield batchedCollections;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async *getEvents({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
		const connection = this.pool.getConnection();
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload
            FROM \`${collection}\`
            WHERE stream_id = ?
            ${fromVersion ? 'AND version >= ?' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ?
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const client = await connection;
		const stream = client.queryStream(query, params);

		try {
			let batchedEvents: IEvent[] = [];
			for await (const { event, payload } of stream as unknown as Pick<MariaDBEventEntity, 'event' | 'payload'>[]) {
				batchedEvents.push(this.eventMap.deserializeEvent(event, payload));
				if (batchedEvents.length === batch) {
					yield batchedEvents;
					batchedEvents = [];
				}
			}
			if (batchedEvents.length > 0) {
				yield batchedEvents;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);

		const [entity] = await this.pool.query<Pick<MariaDBEventEntity, 'event' | 'payload'>[]>(
			`SELECT event, payload FROM \`${collection}\` WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	async appendEvents(
		stream: EventStream,
		aggregateVersion: number,
		events: IEvent[] | EventEnvelope[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const connection = await this.pool.getConnection();
		const collection = EventCollection.get(pool);

		try {
			// Step 1: Get the current version of the stream from the database
			const [currentVersionResult] = await connection.query(
				`SELECT MAX(version) as version FROM \`${collection}\` WHERE stream_id = ?`,
				[stream.streamId],
			);

			const currentVersion = currentVersionResult?.version || 0;

			// Step 2: Check if the aggregateVersion is greater than the current version
			if (aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

			// Step 3: Prepare the events for insertion
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

			await connection.beginTransaction();
			await connection.batch(
				`INSERT INTO \`${collection}\` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				envelopes.map(({ event, payload, metadata }) => [
					stream.streamId,
					metadata.version,
					event,
					JSON.stringify(payload),
					metadata.eventId.value,
					metadata.aggregateId,
					metadata.occurredOn,
					metadata.correlationId ?? null,
					metadata.causationId ?? null,
				]),
			);
			await connection.commit();

			return envelopes;
		} catch (error) {
			await connection.rollback();
			switch (error.constructor) {
				case EventStoreVersionConflictException:
					throw error;
				default:
					throw new EventStorePersistenceException(collection, error);
			}
		} finally {
			connection.release();
		}
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const connection = this.pool.getConnection();
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id
            FROM \`${collection}\`
            WHERE stream_id = ?
            ${fromVersion ? 'AND version >= ?' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ?
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const client = await connection;
		const stream = client.queryStream(query, params);

		try {
			let batchedEvents: EventEnvelope[] = [];
			for await (const {
				event,
				payload,
				event_id,
				aggregate_id,
				version,
				occurred_on,
				correlation_id,
				causation_id,
			} of stream as unknown as Omit<MariaDBEventEntity, 'stream_id'>[]) {
				batchedEvents.push(
					EventEnvelope.from(event, payload, {
						eventId: EventId.from(event_id),
						aggregateId: aggregate_id,
						version,
						occurredOn: occurred_on,
						correlationId: correlation_id,
						causationId: causation_id,
					}),
				);
				if (batchedEvents.length === batch) {
					yield batchedEvents;
					batchedEvents = [];
				}
			}
			if (batchedEvents.length > 0) {
				yield batchedEvents;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		const [entity] = await this.pool.query<Omit<MariaDBEventEntity, 'stream_id'>[]>(
			`SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id FROM \`${collection}\` WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity.event, entity.payload, {
			eventId: EventId.from(entity.event_id),
			aggregateId: entity.aggregate_id,
			version: entity.version,
			occurredOn: entity.occurred_on,
			correlationId: entity.correlation_id,
			causationId: entity.causation_id,
		});
	}
}
