import { escapeIdentifier } from 'pg';

// The 3.x (schema v1) tables, as the published 3.0.0 and 3.0.2 packages create them, for the migration specs.
// Copied from lib/postgres.event-store.ts and lib/postgres.snapshot-store.ts at the tags
// @ocoda/event-sourcing-postgres@3.0.0 and @3.0.2; the column definitions are the same in every 3.0.x release.

const EVENT_COLUMNS = `
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
                `;

const SNAPSHOT_COLUMNS = `
                    stream_id VARCHAR(90) NOT NULL,
                    version INT NOT NULL,
                    payload JSONB NOT NULL,
                    snapshot_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    registered_on TIMESTAMP NOT NULL,
                    aggregate_name VARCHAR(50) NOT NULL,
                    latest VARCHAR(100),
                    PRIMARY KEY (stream_id, version)
                `;

/**
 * How the secondary index of a 3.x table looks in the field:
 * - `3.0.0`: the fixed names `idx_event_date_id` and `idx_aggregate_name_latest` (schema-wide, so only the first pool of
 *   a schema got them);
 * - `3.0.2`: the names that `deriveIndexName` derives from the table name (3.0.1 and later);
 * - `custom`: an index that a user created with a name of their own;
 * - `none`: no index (a pool that 3.0.0 created after the first one).
 */
export type IndexVariant = '3.0.0' | '3.0.2' | 'custom' | 'none';

/**
 * The name of the secondary index of a 3.x table, as `deriveIndexName` derived it in 3.0.1 and 3.0.2 (for names that
 * fit in 63 bytes).
 */
const derivedIndexName = (table: string, suffix: string) => `idx_${table}_${suffix}`;

const indexStatement = (table: string, variant: IndexVariant, kind: 'events' | 'snapshots'): string[] => {
	const [suffix, columns, fixed] =
		kind === 'events'
			? ['event_date_id', 'event_date, event_id', 'idx_event_date_id']
			: ['aggregate_name_latest', 'aggregate_name, latest', 'idx_aggregate_name_latest'];
	switch (variant) {
		case '3.0.0':
			return [`CREATE INDEX IF NOT EXISTS "${fixed}" ON "${table}" (${columns})`];
		case '3.0.2':
			return [
				`CREATE INDEX IF NOT EXISTS ${escapeIdentifier(derivedIndexName(table, suffix))} ON ${escapeIdentifier(table)} (${columns})`,
			];
		case 'custom':
			return [`CREATE INDEX ${escapeIdentifier(`${table}_custom`)} ON ${escapeIdentifier(table)} (${columns})`];
		case 'none':
			return [];
	}
};

/**
 * The statements that create a 3.x event table with the given index variant.
 */
export const v1EventTableStatements = (table: string, variant: IndexVariant = '3.0.2'): string[] => [
	`CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table)} (${EVENT_COLUMNS})`,
	...indexStatement(table, variant, 'events'),
];

/**
 * The statements that create a 3.x snapshot table with the given index variant.
 */
export const v1SnapshotTableStatements = (table: string, variant: IndexVariant = '3.0.2'): string[] => [
	`CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table)} (${SNAPSHOT_COLUMNS})`,
	...indexStatement(table, variant, 'snapshots'),
];

/**
 * A row of a 3.x event table.
 */
export interface V1EventRow {
	stream_id: string;
	version: number;
	event: string;
	payload: unknown;
	event_id: string;
	aggregate_id: string;
	occurred_on: string;
	correlation_id?: string | null;
	causation_id?: string | null;
}

/**
 * Inserts rows the way 3.x did: every column named, `event_date` the UTC year and month of the event id's time.
 */
export const v1EventInsert = (table: string, rows: readonly V1EventRow[]): [string, unknown[]] => {
	const values: string[] = [];
	const params: unknown[] = [];
	for (const row of rows) {
		const offset = params.length;
		values.push(`(${Array.from({ length: 10 }, (_, index) => `$${offset + index + 1}`).join(', ')})`);
		params.push(
			row.stream_id,
			row.version,
			row.event,
			JSON.stringify(row.payload),
			ulidYearMonth(row.event_id),
			row.event_id,
			row.aggregate_id,
			row.occurred_on,
			row.correlation_id ?? null,
			row.causation_id ?? null,
		);
	}
	return [
		`INSERT INTO ${escapeIdentifier(table)} (stream_id, version, event, payload, event_date, event_id, aggregate_id, occurred_on, correlation_id, causation_id) VALUES ${values.join(', ')}`,
		params,
	];
};

/**
 * A row of a 3.x snapshot table. `registered_on` is the wall time of the writing process (`TIMESTAMP`).
 */
export interface V1SnapshotRow {
	stream_id: string;
	version: number;
	payload: unknown;
	snapshot_id: string;
	aggregate_id: string;
	registered_on: string;
	aggregate_name: string;
	latest: string | null;
}

export const v1SnapshotInsert = (table: string, rows: readonly V1SnapshotRow[]): [string, unknown[]] => {
	const values: string[] = [];
	const params: unknown[] = [];
	for (const row of rows) {
		const offset = params.length;
		values.push(`(${Array.from({ length: 8 }, (_, index) => `$${offset + index + 1}`).join(', ')})`);
		params.push(
			row.stream_id,
			row.version,
			JSON.stringify(row.payload),
			row.snapshot_id,
			row.aggregate_id,
			row.registered_on,
			row.aggregate_name,
			row.latest,
		);
	}
	return [
		`INSERT INTO ${escapeIdentifier(table)} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest) VALUES ${values.join(', ')}`,
		params,
	];
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The time of a ULID, from its first 10 characters (case-insensitive, like 3.x read it).
 */
export const ulidTime = (id: string): number =>
	[...id.slice(0, 10).toUpperCase()].reduce((time, character) => time * 32 + CROCKFORD.indexOf(character), 0);

/**
 * A ULID with the given time and a random part made of `suffix` (padded to 16 characters).
 */
export const ulidAt = (time: number, suffix: string): string => {
	let encoded = '';
	let rest = time;
	for (let index = 0; index < 10; index++) {
		encoded = CROCKFORD[rest % 32] + encoded;
		rest = Math.floor(rest / 32);
	}
	return `${encoded}${suffix.padStart(16, '0')}`;
};

/**
 * 3.x's `event_date`: the UTC year and month of the event id's time (`YYYY-MM`).
 */
export const ulidYearMonth = (id: string): string => new Date(ulidTime(id)).toISOString().slice(0, 7);
