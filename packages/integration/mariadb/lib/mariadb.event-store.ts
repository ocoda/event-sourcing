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
	type IAllEventsFilter,
	type IEvent,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventFilter,
	type IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { type Pool, type PoolConnection, createPool } from 'mariadb';
import type { MariaDBEventEntity, MariaDBEventStoreConfig } from './interfaces/index.js';
import { isDuplicateEntryError, streamRows } from './mariadb.utils.js';

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
				`CREATE TABLE IF NOT EXISTS ${this.pool.escapeId(collection)} (
                    stream_id VARCHAR(120) NOT NULL,
                    version INT NOT NULL,
                    event VARCHAR(80) NOT NULL,
                    payload JSON NOT NULL,
					event_date VARCHAR(7) NOT NULL,
                    event_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    occurred_on TIMESTAMP NOT NULL,
                    correlation_id VARCHAR(255),
                    causation_id VARCHAR(255),
                    PRIMARY KEY (stream_id, version),
					INDEX idx_event_date_id (event_date, event_id)
                )`,
			);

			return collection;
		} catch (error) {
			throw new EventStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = "SELECT TABLE_NAME FROM information_schema.tables WHERE BINARY table_name LIKE '%events'";

		let batchedCollections: IEventCollection[] = [];
		for await (const { TABLE_NAME } of streamRows<Record<string, IEventCollection>>(this.pool, query)) {
			batchedCollections.push(TABLE_NAME);
			if (batchedCollections.length === batch) {
				yield batchedCollections;
				batchedCollections = [];
			}
		}
		if (batchedCollections.length > 0) {
			yield batchedCollections;
		}
	}

	async *getEvents({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload
            FROM ${this.pool.escapeId(collection)}
            WHERE stream_id = ?
            ${fromVersion ? 'AND version >= ?' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ?
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		let batchedEvents: IEvent[] = [];
		for await (const { event, payload } of streamRows<Pick<MariaDBEventEntity, 'event' | 'payload'>>(
			this.pool,
			query,
			params,
		)) {
			batchedEvents.push(this.eventMap.deserializeEvent(event, payload));
			if (batchedEvents.length === batch) {
				yield batchedEvents;
				batchedEvents = [];
			}
		}
		if (batchedEvents.length > 0) {
			yield batchedEvents;
		}
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);

		const [entity] = await this.pool.query<Pick<MariaDBEventEntity, 'event' | 'payload'>[]>(
			`SELECT event, payload FROM ${this.pool.escapeId(collection)} WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);

		if (!entity) {
			throw new EventNotFoundException({ streamId, version, pool });
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

		let currentVersion = 0;
		// Set once the commit was sent: from then on a failure may have stored the events
		let committing = false;

		try {
			// Escaped inside the try, so a name the connector refuses to escape still releases the connection
			const table = connection.escapeId(collection);

			// Step 1: Get the current version of the stream from the database
			const [currentVersionResult] = await connection.query(
				`SELECT MAX(version) as version FROM ${table} WHERE stream_id = ?`,
				[stream.streamId],
			);

			currentVersion = currentVersionResult?.version || 0;

			// Step 2: Check if the aggregateVersion is greater than the current version
			if (aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException({
					stream,
					expectedVersion: aggregateVersion - events.length,
					actualVersion: currentVersion,
					pool,
				});
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
				`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				envelopes.map(({ event, payload, metadata }) => [
					stream.streamId,
					metadata.version,
					event,
					JSON.stringify(payload),
					metadata.eventId.yearMonth,
					metadata.eventId.value,
					metadata.aggregateId,
					metadata.occurredOn,
					metadata.correlationId ?? null,
					metadata.causationId ?? null,
				]),
			);
			committing = true;
			await connection.commit();

			return envelopes;
		} catch (error) {
			await connection.rollback().catch(() => undefined);

			if (error instanceof EventStoreVersionConflictException) {
				throw error;
			}

			// A concurrent writer committed the same (stream_id, version) between our check and our insert.
			if (isDuplicateEntryError(error)) {
				const latestVersion = await this.getLatestVersion(collection, stream, connection);
				throw new EventStoreVersionConflictException(
					{ stream, expectedVersion: aggregateVersion - events.length, actualVersion: latestVersion, pool },
					{ cause: error },
				);
			}

			// Until the commit is sent, the transaction is rolled back (or dropped with the connection)
			const outcome = committing ? 'unknown' : 'not-persisted';
			throw new EventStorePersistenceException({ collection, outcome }, { cause: error });
		} finally {
			await connection.release();
		}
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		const [entity] = await this.pool.query<Omit<MariaDBEventEntity, 'stream_id'>[]>(
			`SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id FROM ${this.pool.escapeId(collection)} WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);

		if (!entity) {
			throw new EventNotFoundException({ streamId, version, pool });
		}

		return EventEnvelope.from(entity.event, entity.payload, {
			eventId: EventId.from(entity.event_id),
			aggregateId: entity.aggregate_id,
			version: entity.version,
			occurredOn: entity.occurred_on,
			correlationId: entity.correlation_id ?? undefined,
			causationId: entity.causation_id ?? undefined,
		});
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id
            FROM ${this.pool.escapeId(collection)}
            WHERE stream_id = ?
            ${fromVersion ? 'AND version >= ?' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ?
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

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
		} of streamRows<Omit<MariaDBEventEntity, 'stream_id'>>(this.pool, query, params)) {
			batchedEvents.push(
				EventEnvelope.from(event, payload, {
					eventId: EventId.from(event_id),
					aggregateId: aggregate_id,
					version,
					occurredOn: occurred_on,
					correlationId: correlation_id ?? undefined,
					causationId: causation_id ?? undefined,
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
	}

	async *getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		const yearMonths = this.getYearMonthRange(filter.since, filter.until);

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id
            FROM ${this.pool.escapeId(collection)}
            WHERE event_date IN (?)
            ORDER BY event_date ASC, event_id ASC
        `;

		const params = [yearMonths];

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
		} of streamRows<Omit<MariaDBEventEntity, 'stream_id'>>(this.pool, query, params)) {
			batchedEvents.push(
				EventEnvelope.from(event, payload, {
					eventId: EventId.from(event_id),
					aggregateId: aggregate_id,
					version,
					occurredOn: occurred_on,
					correlationId: correlation_id ?? undefined,
					causationId: causation_id ?? undefined,
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
	}

	/**
	 * Best effort lookup of the latest version of a stream, used to report a conflict.
	 */
	private async getLatestVersion(
		collection: IEventCollection,
		{ streamId }: EventStream,
		connection: PoolConnection,
	): Promise<number | undefined> {
		try {
			const [result] = await connection.query(
				`SELECT MAX(version) as version FROM ${connection.escapeId(collection)} WHERE stream_id = ?`,
				[streamId],
			);
			return result?.version ?? undefined;
		} catch {
			return undefined;
		}
	}
}
