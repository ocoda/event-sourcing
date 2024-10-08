import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventEnvelope,
	EventNotFoundException,
	EventStore,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	type EventStream,
	type IEvent,
	type IEventCollection,
	type IEventFilter,
	type IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { Pool, type PoolClient } from 'pg';
import Cursor from 'pg-cursor';
import type { PostgresEventEntity, PostgresEventStoreConfig } from './interfaces';

export class PostgresEventStore extends EventStore<PostgresEventStoreConfig> {
	private pool: Pool;
	private client: PoolClient;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = new Pool(this.options);
		this.client = await this.pool.connect();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.client.release();
		await this.pool.end();
	}

	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);

		try {
			await this.client.query(
				`CREATE TABLE IF NOT EXISTS "${collection}" (
                    stream_id VARCHAR(120) NOT NULL,
                    version INT NOT NULL,
                    event VARCHAR(80) NOT NULL,
                    payload JSONB NOT NULL,
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

	async *getEvents({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload
            FROM "${collection}"
            WHERE stream_id = $1
            ${fromVersion ? 'AND version >= $2' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ${fromVersion ? '$3' : '$2'}
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const cursor = this.client.query(new Cursor<Pick<PostgresEventEntity, 'event' | 'payload'>>(query, params));

		let done = false;

		while (!done) {
			const rows: Array<Pick<PostgresEventEntity, 'event' | 'payload'>> = await new Promise((resolve, reject) =>
				cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
			);

			if (rows.length === 0) {
				done = true;
			} else {
				const entities = rows.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));
				yield entities;
			}
		}

		cursor.close(() => {});
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);

		const { rows: entities } = await this.client.query<Pick<PostgresEventEntity, 'event' | 'payload'>>(
			`SELECT event, payload FROM "${collection}" WHERE stream_id = $1 AND version = $2`,
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
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		try {
			const { rows: currentVersionRows } = await this.client.query<{ version: number }>(
				`SELECT MAX(version) as version FROM "${collection}" WHERE stream_id = $1`,
				[stream.streamId],
			);

			const currentVersion = currentVersionRows[0]?.version || 0;

			if (aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

			let version = aggregateVersion - events.length + 1;

			const envelopes: EventEnvelope[] = [];
			for (const event of events) {
				const name = this.eventMap.getName(event);
				const payload = this.eventMap.serializeEvent(event);
				const envelope = EventEnvelope.create(name, payload, { aggregateId: stream.aggregateId, version: version++ });
				envelopes.push(envelope);
			}

			const entities = envelopes.map(
				({ event, payload, metadata }) =>
					`('${stream.streamId}', ${metadata.version}, '${event}', '${JSON.stringify(payload)}', '${metadata.eventId}', '${metadata.aggregateId}', '${metadata.occurredOn.toISOString()}', ${metadata.correlationId ?? null}, ${metadata.causationId ?? null})`,
			);

			await this.client.query(`
            INSERT INTO "${collection}" (stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id)
		    VALUES ${entities.join(',')}
		`);

			return envelopes;
		} catch (error) {
			switch (error.constructor) {
				case EventStoreVersionConflictException:
					throw error;
				default:
					throw new EventStorePersistenceException(collection, error);
			}
		}
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
            FROM "${collection}"
            WHERE stream_id = $1
            ${fromVersion ? 'AND version >= $2' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ${fromVersion ? '$3' : '$2'}
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const cursor = this.client.query(
			new Cursor<
				Pick<
					PostgresEventEntity,
					| 'event'
					| 'payload'
					| 'event_id'
					| 'aggregate_id'
					| 'version'
					| 'occurred_on'
					| 'correlation_id'
					| 'causation_id'
				>
			>(query, params),
		);

		let done = false;

		while (!done) {
			const rows: Array<
				Pick<
					PostgresEventEntity,
					| 'event'
					| 'payload'
					| 'event_id'
					| 'aggregate_id'
					| 'version'
					| 'occurred_on'
					| 'correlation_id'
					| 'causation_id'
				>
			> = await new Promise((resolve, reject) =>
				cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
			);

			if (rows.length === 0) {
				done = true;
			} else {
				const entities = rows.map(
					({ event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id }) =>
						EventEnvelope.from(event, payload, {
							eventId: event_id,
							aggregateId: aggregate_id,
							version,
							occurredOn: occurred_on,
							correlationId: correlation_id,
							causationId: causation_id,
						}),
				);
				yield entities;
			}
		}

		cursor.close(() => {});
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		const { rows: entities } = await this.client.query<
			Pick<
				PostgresEventEntity,
				| 'event'
				| 'payload'
				| 'event_id'
				| 'aggregate_id'
				| 'version'
				| 'occurred_on'
				| 'correlation_id'
				| 'causation_id'
			>
		>(
			`SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id FROM "${collection}" WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity.event, entity.payload, {
			eventId: entity.event_id,
			aggregateId: entity.aggregate_id,
			version: entity.version,
			occurredOn: entity.occurred_on,
			correlationId: entity.correlation_id,
			causationId: entity.causation_id,
		});
	}
}
