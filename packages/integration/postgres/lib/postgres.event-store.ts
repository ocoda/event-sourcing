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
import { Pool, escapeIdentifier } from 'pg';
import type { PostgresEventEntity, PostgresEventStoreConfig } from './interfaces/index.js';
import { UNIQUE_VIOLATION, ensureTable, hasErrorCode, readInBatches } from './postgres.helpers.js';

type PostgresEnvelopeEntity = Pick<
	PostgresEventEntity,
	'event' | 'payload' | 'event_id' | 'aggregate_id' | 'version' | 'occurred_on' | 'correlation_id' | 'causation_id'
>;

export class PostgresEventStore extends EventStore<PostgresEventStoreConfig> {
	private pool: Pool;

	private readonly columns = [
		'stream_id',
		'version',
		'event',
		'payload',
		'event_date',
		'event_id',
		'aggregate_id',
		'occurred_on',
		'correlation_id',
		'causation_id',
	] as const;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = new Pool(this.options);
		// Idle connections that fail are discarded by the pool, without a listener the error would crash the process
		this.pool.on('error', (error) => this.logger.error(`Idle database connection failed: ${error.message}`));

		// Fail fast when the database can't be reached
		const client = await this.pool.connect();
		client.release();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		await this.pool.end();
	}

	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);

		try {
			await ensureTable(this.pool, this.logger, {
				table: collection,
				definition: `
                    stream_id VARCHAR(120) NOT NULL,
                    version INT NOT NULL,
                    event VARCHAR(80) NOT NULL,
                    payload JSONB NOT NULL,
                    event_date VARCHAR(7) NOT NULL,
                    event_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    occurred_on TIMESTAMPTZ NOT NULL,
                    correlation_id VARCHAR(255),
                    causation_id VARCHAR(255),
                    PRIMARY KEY (stream_id, version)
                `,
				index: { suffix: 'event_date_id', columns: ['event_date', 'event_id'] },
			});

			return collection;
		} catch (error) {
			throw new EventStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `SELECT tablename FROM pg_catalog.pg_tables WHERE tablename LIKE '%events'`;

		for await (const rows of readInBatches<{ tablename: IEventCollection }>(this.pool, query, [], batch)) {
			yield rows.map(({ tablename }) => tablename);
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
            FROM ${escapeIdentifier(collection)}
            WHERE stream_id = $1
            ${fromVersion ? 'AND version >= $2' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ${fromVersion ? '$3' : '$2'}
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		for await (const rows of readInBatches<Pick<PostgresEventEntity, 'event' | 'payload'>>(
			this.pool,
			query,
			params,
			batch,
		)) {
			yield rows.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));
		}
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);

		const { rows: entities } = await this.pool.query<Pick<PostgresEventEntity, 'event' | 'payload'>>(
			`SELECT event, payload FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

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
		const collection = EventCollection.get(pool);
		const table = escapeIdentifier(collection);

		try {
			const currentVersion = await this.getCurrentVersion(table, stream);

			if (aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

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

			const values: string[] = [];
			const params: PostgresEventEntity[keyof PostgresEventEntity][] = [];
			let paramIndex = 1;
			for (const envelope of envelopes) {
				values.push(`(${this.columns.map(() => `$${paramIndex++}`).join(', ')})`);
				params.push(
					stream.streamId,
					envelope.metadata.version,
					envelope.event,
					envelope.payload,
					envelope.metadata.eventId.yearMonth,
					envelope.metadata.eventId.value,
					envelope.metadata.aggregateId,
					envelope.metadata.occurredOn.toISOString(),
					envelope.metadata.correlationId ?? null,
					envelope.metadata.causationId ?? null,
				);
			}

			await this.pool.query(`INSERT INTO ${table} (${this.columns.join(', ')}) VALUES ${values.join(',')}`, params);

			return envelopes;
		} catch (error) {
			if (error instanceof EventStoreVersionConflictException) {
				throw error;
			}

			// A concurrent writer appended the same version(s) after the version check
			if (hasErrorCode(error, UNIQUE_VIOLATION)) {
				const latestVersion = await this.getCurrentVersion(table, stream).catch(() => aggregateVersion);
				throw new EventStoreVersionConflictException(stream, aggregateVersion, latestVersion, error);
			}

			throw new EventStorePersistenceException(collection, error);
		}
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		const { rows: entities } = await this.pool.query<PostgresEnvelopeEntity>(
			`SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.toEnvelope(entity);
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		// Build the SQL query with parameterized inputs
		const query = `
            SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id
            FROM ${escapeIdentifier(collection)}
            WHERE stream_id = $1
            ${fromVersion ? 'AND version >= $2' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ${fromVersion ? '$3' : '$2'}
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		for await (const rows of readInBatches<PostgresEnvelopeEntity>(this.pool, query, params, batch)) {
			yield rows.map((row) => this.toEnvelope(row));
		}
	}

	async *getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		const yearMonths = this.getYearMonthRange(filter.since, filter.until);

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		// Build the SQL query with parameterized inputs
		const query = `
            SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id
            FROM ${escapeIdentifier(collection)}
            WHERE event_date = ANY ($1)
            ORDER BY event_date ASC, event_id ASC
        `;

		const params = [yearMonths];

		for await (const rows of readInBatches<PostgresEnvelopeEntity>(this.pool, query, params, batch)) {
			yield rows.map((row) => this.toEnvelope(row));
		}
	}

	private async getCurrentVersion(table: string, { streamId }: EventStream): Promise<number> {
		const { rows } = await this.pool.query<{ version: number | null }>(
			`SELECT MAX(version) as version FROM ${table} WHERE stream_id = $1`,
			[streamId],
		);

		return rows[0]?.version || 0;
	}

	private toEnvelope({
		event,
		payload,
		event_id,
		aggregate_id,
		version,
		occurred_on,
		correlation_id,
		causation_id,
	}: PostgresEnvelopeEntity): EventEnvelope {
		return EventEnvelope.from(event, payload, {
			eventId: EventId.from(event_id),
			aggregateId: aggregate_id,
			version,
			occurredOn: occurred_on,
			correlationId: correlation_id ?? undefined,
			causationId: causation_id ?? undefined,
		});
	}
}
