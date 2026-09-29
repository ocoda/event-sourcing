import { EventId } from '@ocoda/event-sourcing';
import type { Connection, Pool } from 'mariadb';

/**
 * The 3.x schema of the MariaDB stores, verbatim: 3.0.0 to 3.0.2 create these tables (3.0.0 quoted the name with
 * backticks, 3.0.1 and later with the connector's `escapeId`, which gives the same statement). They have no character
 * set or collation of their own, so they get the database's default.
 */
export const v1EventTableDdl = (table: string, tableOptions = ''): string =>
	`CREATE TABLE IF NOT EXISTS ${escapeId(table)} (
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
                )${tableOptions ? ` ${tableOptions}` : ''}`;

export const v1SnapshotTableDdl = (table: string, tableOptions = ''): string =>
	`CREATE TABLE IF NOT EXISTS ${escapeId(table)} (
                    stream_id VARCHAR(90) NOT NULL,
                    version INT NOT NULL,
                    payload JSON NOT NULL,
                    snapshot_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    registered_on TIMESTAMP NOT NULL,
                    aggregate_name VARCHAR(50) NOT NULL,
                    latest VARCHAR(100),
                    PRIMARY KEY (stream_id, version),
                    INDEX idx_aggregate_name_latest (aggregate_name, latest)
                )${tableOptions ? ` ${tableOptions}` : ''}`;

/** On MariaDB 10.9 and earlier this was the server default: the first TIMESTAMP column gets `ON UPDATE`. */
export const LEGACY_TIMESTAMP_SESSION = 'SET SESSION explicit_defaults_for_timestamp = OFF';

export const escapeId = (name: string): string => `\`${name.replaceAll('`', '``')}\``;

/** A 3.x event row: the ten values of 3.x's positional insert. */
export interface V1EventRow {
	streamId: string;
	version: number;
	event: string;
	payload: Record<string, unknown>;
	eventId: string;
	aggregateId: string;
	/** What 3.x stored in the `TIMESTAMP(0)`, as UTC wall time `YYYY-MM-DD HH:MM:SS` (the session is UTC). */
	occurredOn: string;
	/** The `event_date`, when the event id has no ULID time to derive it from. */
	eventDate?: string;
	correlationId?: string | null;
	causationId?: string | null;
}

/** The `event_date` 3.x derived from the event id: its UTC year and month. */
export const yearMonthOf = (eventId: string): string => EventId.fromTrusted(eventId).date.toISOString().slice(0, 7);

/**
 * Inserts rows the way 3.x does (positional, ten values). The connection's session must be UTC for `occurredOn` to be
 * stored as given.
 */
export const insertV1Events = async (db: Connection | Pool, table: string, rows: readonly V1EventRow[]) => {
	for (const row of rows) {
		await db.query(`INSERT INTO ${escapeId(table)} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			row.streamId,
			row.version,
			row.event,
			JSON.stringify(row.payload),
			row.eventDate ?? yearMonthOf(row.eventId),
			row.eventId,
			row.aggregateId,
			row.occurredOn,
			row.correlationId ?? null,
			row.causationId ?? null,
		]);
	}
};

/** A 3.x snapshot row: the eight values of 3.x's positional insert. */
export interface V1SnapshotRow {
	streamId: string;
	version: number;
	payload: Record<string, unknown>;
	snapshotId: string;
	aggregateId: string;
	/** UTC wall time, `YYYY-MM-DD HH:MM:SS`. */
	registeredOn: string;
	aggregateName: string;
	latest: boolean;
}

export const insertV1Snapshots = async (db: Connection | Pool, table: string, rows: readonly V1SnapshotRow[]) => {
	for (const row of rows) {
		await db.query(`INSERT INTO ${escapeId(table)} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
			row.streamId,
			row.version,
			JSON.stringify(row.payload),
			row.snapshotId,
			row.aggregateId,
			row.registeredOn,
			row.aggregateName,
			row.latest ? `latest#${row.streamId}` : null,
		]);
	}
};
