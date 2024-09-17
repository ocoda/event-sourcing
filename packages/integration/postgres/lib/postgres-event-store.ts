import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventEnvelope,
	EventFilter,
	EventNotFoundException,
	EventStore,
	EventStream,
	IEvent,
	IEventCollection,
	IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { Pool, PoolClient } from 'pg';
import Cursor from 'pg-cursor';
import { PostgresEventEntity, PostgresEventStoreConfig } from './interfaces';

export class PostgresEventStore extends EventStore<PostgresEventStoreConfig> {
	private pool: Pool;
	private client: PoolClient;

	async start(): Promise<IEventCollection> {
		this.logger.log('Starting store');
		const { pool, ...params } = this.options;

		this.pool = new Pool(params);
		this.client = await this.pool.connect();

		const collection = EventCollection.get(pool);

		await this.client.query(
			`CREATE TABLE IF NOT EXISTS "${collection}" (
                stream_id VARCHAR(255) NOT NULL,
                version INT NOT NULL,
                event VARCHAR(255) NOT NULL,
                payload JSONB NOT NULL,
                event_id VARCHAR(255) NOT NULL,
                aggregate_id VARCHAR(255) NOT NULL,
                occurred_on TIMESTAMP NOT NULL,
                correlation_id VARCHAR(255),
                causation_id VARCHAR(255),
                PRIMARY KEY (stream_id, version)
            )`,
		);

		return collection;
	}

	async stop(): Promise<void> {
		this.logger.log('Stopping store');
		this.client.release();
		await this.pool.end();
	}

	async *getEvents({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT event, payload
            FROM ${collection}
            WHERE stream_id = $1
            ${fromVersion ? 'AND version >= $2' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ${fromVersion ? '$3' : '$2'}
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const cursor = this.client.query(new Cursor<PostgresEventEntity>(query, params));

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

		const { rows: entities } = await this.client.query<PostgresEventEntity>(
			`SELECT * FROM "${collection}" WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	async appendEvents(
		{ streamId, aggregateId }: EventStream,
		aggregateVersion: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		let version = aggregateVersion - events.length + 1;

		const envelopes: EventEnvelope[] = [];
		for (const event of events) {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			envelopes.push(envelope);
		}

		const entities = envelopes.map(
			({ event, payload, metadata }) =>
				`('${streamId}', ${metadata.version}, '${event}', '${JSON.stringify(payload)}', '${metadata.eventId}', '${metadata.aggregateId}', '${metadata.occurredOn.toISOString()}', ${metadata.correlationId ?? null}, ${metadata.causationId ?? null})`,
		);

		await this.client.query(`
            INSERT INTO "${collection}" (stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id)
		    VALUES ${entities.join(',')}
		`);

		return envelopes;
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		// Build the SQL query with parameterized inputs
		const query = `
            SELECT *
            FROM ${collection}
            WHERE stream_id = $1
            ${fromVersion ? 'AND version >= $2' : ''}
            ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
            LIMIT ${fromVersion ? '$3' : '$2'}
        `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const cursor = this.client.query(new Cursor<PostgresEventEntity>(query, params));

		let done = false;

		while (!done) {
			const rows: Array<PostgresEventEntity> = await new Promise((resolve, reject) =>
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

		const { rows: entities } = await this.client.query<PostgresEventEntity>(
			`SELECT * FROM "${collection}" WHERE stream_id = $1 AND version = $2`,
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
