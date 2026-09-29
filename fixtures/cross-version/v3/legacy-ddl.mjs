// "Wild" 3.x schema states that a fresh 3.0.2 install doesn't produce, but that 3.x databases in the field have.
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import pg from 'pg';

/**
 * PostgreSQL index variants.
 *
 * - 3.0.0 created its indexes with fixed names (`idx_event_date_id`, `idx_aggregate_name_latest`). Index names are
 *   schema-wide, so only the first pool of a schema got them. `tenantPool` gets these names instead of the derived
 *   ones of 3.0.1 and later.
 * - A pool created by 3.0.0 after the first one has no index at all: `bareCollections` lose theirs.
 *
 * Returns the resulting indexes (name and definition) of every table of the namespace.
 */
export const applyPostgresIndexVariants = async (client, { tenantPool, bareCollections }) => {
	const replace = async (table, columns, fixedName) => {
		for (const index of await secondaryIndexes(client, table, columns)) {
			await client.query(`DROP INDEX ${pg.escapeIdentifier(index)}`);
		}
		if (fixedName) {
			await client.query(
				`CREATE INDEX ${pg.escapeIdentifier(fixedName)} ON ${pg.escapeIdentifier(table)} (${columns.join(', ')})`,
			);
		}
	};

	await replace(`${tenantPool}-events`, ['event_date', 'event_id'], 'idx_event_date_id');
	await replace(`${tenantPool}-snapshots`, ['aggregate_name', 'latest'], 'idx_aggregate_name_latest');
	for (const collection of bareCollections) {
		const columns = collection.endsWith('-snapshots') ? ['aggregate_name', 'latest'] : ['event_date', 'event_id'];
		await replace(collection, columns, undefined);
	}

	const rows = await client.query(
		`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
		 ORDER BY tablename, indexname`,
	);
	const indexes = {};
	for (const { tablename, indexname, indexdef } of rows) {
		(indexes[tablename] ??= []).push({ name: indexname, definition: indexdef });
	}
	return indexes;
};

/** The non-unique indexes of a table of the current schema whose key columns are exactly `columns`. */
const secondaryIndexes = async (client, table, columns) => {
	const rows = await client.query(
		`SELECT ic.relname AS name, array_agg(a.attname ORDER BY k.ordinality)::text[] AS columns
		 FROM pg_index i
		 JOIN pg_class ic ON ic.oid = i.indexrelid
		 CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ordinality)
		 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		 WHERE i.indrelid = to_regclass(format('%I.%I', current_schema(), $1::text)) AND NOT i.indisunique
		 GROUP BY ic.relname`,
		[table],
	);
	return rows.filter((row) => row.columns.join(',') === columns.join(',')).map((row) => row.name);
};

/** On MariaDB 10.9 and earlier this was the server default. */
export const LEGACY_SESSION_SQL = 'SET SESSION explicit_defaults_for_timestamp=OFF';

/**
 * MariaDB stores whose sessions create tables the way servers with `explicit_defaults_for_timestamp=OFF` did: the
 * first `TIMESTAMP NOT NULL` column (`occurred_on`, `registered_on`) becomes
 * `DEFAULT current_timestamp() ON UPDATE current_timestamp()`. Creates the collections of `pool` and fails unless
 * both tables have the `ON UPDATE` clause. Returns the connected stores and the `SHOW CREATE TABLE` output.
 */
export const openLegacyMariaDBStores = async ({ client, eventMap, options, pool }) => {
	const legacyOptions = { ...options, initSql: LEGACY_SESSION_SQL };
	const eventStore = new MariaDBEventStore(eventMap, legacyOptions);
	const snapshotStore = new MariaDBSnapshotStore(legacyOptions);
	eventStore.publish = () => undefined;
	await Promise.all([eventStore.connect(), snapshotStore.connect()]);
	const collections = [await eventStore.ensureCollection(pool), await snapshotStore.ensureCollection(pool)];

	const ddl = {};
	for (const [collection, column] of [
		[collections[0], 'occurred_on'],
		[collections[1], 'registered_on'],
	]) {
		const [row] = await client.query(`SHOW CREATE TABLE \`${collection}\``);
		const statement = row['Create Table'];
		const definition = statement.split('\n').find((line) => line.includes(`\`${column}\``)) ?? '';
		if (!/on update/i.test(definition)) {
			throw new Error(
				`${collection}.${column} was created without ON UPDATE, so the legacy DDL was not reproduced (${LEGACY_SESSION_SQL}): ${definition.trim()}`,
			);
		}
		ddl[collection] = statement;
	}

	return {
		eventStore,
		snapshotStore,
		ddl,
		close: () => Promise.all([eventStore.disconnect(), snapshotStore.disconnect()]),
	};
};
