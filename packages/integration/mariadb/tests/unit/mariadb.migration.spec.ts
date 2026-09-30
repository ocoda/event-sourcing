import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	type EventEnvelope,
	EventSourcingErrorCode,
	Id,
	EventStoreSchemaException,
	EventStream,
	ExpectedVersion,
	type MigrationCollectionReport,
	type MigrationReport,
	SnapshotCollection,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { Account, AccountId, getEventMap, getEvents, mariadbRootConfig } from '@ocoda/event-sourcing-testing/unit';
import type { Connection } from 'mariadb';
import { type MigrationHooks, failureHint, runMigration } from '../../lib/migration/migrate.js';
import {
	LEGACY_TIMESTAMP_SESSION,
	type V1EventRow,
	type V1SnapshotRow,
	escapeId,
	insertV1Events,
	insertV1Snapshots,
	v1EventTableDdl,
	v1SnapshotTableDdl,
} from '../fixtures/schema-v1.js';
import {
	canonicalOf,
	canonicalSnapshotOf,
	canonicalizedReportOf,
	expectedOrder,
	lateV1Event,
	nonCanonicalCount,
	repairCounts,
	repairOf,
	secondsOf,
	ulidAt,
	v1Events,
	v1Snapshots,
} from '../fixtures/v1-corpus.js';
import { createEventStore, createSnapshotStore, createTestDatabase, rootConnection } from '../support/stores.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CATALOG = 'event_sourcing_collections';

describe('MariaDB migration from 3.x to schema v2', () => {
	let database: Awaited<ReturnType<typeof createTestDatabase>>;
	let root: Connection;
	let tableCount = 0;

	/** A pool name of its own for every seeded table. */
	const nextPool = (label: string) => `${label}${++tableCount}`;

	const config = () => database.config;

	const migrateEvents = (options: Parameters<typeof MariaDBEventStore.migrate>[1] = {}, hooks?: MigrationHooks) =>
		hooks ? runMigration(config(), 'events', options, hooks) : MariaDBEventStore.migrate(config(), options);
	const migrateSnapshots = (
		options: Parameters<typeof MariaDBSnapshotStore.migrate>[1] = {},
		hooks?: MigrationHooks,
	) => (hooks ? runMigration(config(), 'snapshots', options, hooks) : MariaDBSnapshotStore.migrate(config(), options));

	const only = (report: MigrationReport, name: string): MigrationCollectionReport => {
		const collection = report.collections.find((candidate) => candidate.name === name);
		expect(collection, `the report of ${name}`).toBeDefined();
		return collection as MigrationCollectionReport;
	};

	/** Creates a 3.x event table the way a server before MariaDB 10.10 did (ON UPDATE), with the corpus in it. */
	const seedEvents = async (
		pool: string,
		{
			tableOptions = '',
			rows = v1Events(),
			legacy = true,
		}: { tableOptions?: string; rows?: V1EventRow[]; legacy?: boolean } = {},
	) => {
		const table = EventCollection.get(pool);
		if (legacy) {
			await root.query(LEGACY_TIMESTAMP_SESSION);
		}
		await root.query(v1EventTableDdl(table, tableOptions));
		await root.query('SET SESSION explicit_defaults_for_timestamp = ON');
		await insertV1Events(root, table, rows);
		return table;
	};

	const seedSnapshots = async (
		pool: string,
		{ tableOptions = '', rows = v1Snapshots() }: { tableOptions?: string; rows?: V1SnapshotRow[] } = {},
	) => {
		const table = SnapshotCollection.get(pool);
		await root.query(LEGACY_TIMESTAMP_SESSION);
		await root.query(v1SnapshotTableDdl(table, tableOptions));
		await root.query('SET SESSION explicit_defaults_for_timestamp = ON');
		await insertV1Snapshots(root, table, rows);
		return table;
	};

	const showCreate = async (table: string): Promise<string> =>
		(await root.query<{ 'Create Table': string }[]>(`SHOW CREATE TABLE ${escapeId(table)}`))[0]['Create Table'];

	const tableExists = async (table: string): Promise<boolean> =>
		(
			await root.query<unknown[]>(
				'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ?',
				[table],
			)
		).length > 0;

	/** The schema and a checksum of every table of the database. */
	const schemaDump = async () => {
		const tables = (
			await root.query<{ TABLE_NAME: string }[]>(
				"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
			)
		).map(({ TABLE_NAME }) => TABLE_NAME);
		const dump: Record<string, { ddl: string; checksum: string }> = {};
		for (const table of tables) {
			const [{ Checksum }] = await root.query<{ Checksum: bigint | null }[]>(`CHECKSUM TABLE ${escapeId(table)}`);
			dump[table] = { ddl: await showCreate(table), checksum: String(Checksum) };
		}
		return dump;
	};

	/** A migrated event table's rows, schema, catalog row and backup, independent of the table's name. */
	const eventTableDump = async (table: string) => ({
		ddl: (await showCreate(table)).replace(escapeId(table), '<t>'),
		rows: await root.query(
			`SELECT stream_id, version, event, payload, event_id, aggregate_id, CAST(occurred_on AS CHAR) AS occurred_on,
				correlation_id, causation_id, CAST(global_position AS CHAR) AS global_position, headers, event_version
			 FROM ${escapeId(table)} e ORDER BY e.global_position`,
		),
		catalog: await root.query(
			`SELECT kind, schema_version, CAST(last_position AS CHAR) AS last_position FROM ${CATALOG} WHERE name = ?`,
			[table],
		),
		backup: await tableExists(`${table}__es_v1`),
		copy: await tableExists(`${table}__es_v2`),
	});

	const snapshotTableDump = async (table: string) => ({
		ddl: (await showCreate(table)).replace(escapeId(table), '<t>'),
		rows: await root.query(
			`SELECT stream_id, version, payload, snapshot_id, aggregate_id, CAST(registered_on AS CHAR) AS registered_on,
				aggregate_name, latest
			 FROM ${escapeId(table)} ORDER BY CAST(stream_id AS BINARY), version`,
		),
		catalog: await root.query(`SELECT kind, schema_version FROM ${CATALOG} WHERE name = ?`, [table]),
	});

	beforeAll(async () => {
		database = await createTestDatabase('mig');
		root = await rootConnection(database.name);
		await root.query("SET SESSION time_zone = '+00:00'");
	});

	afterAll(async () => {
		await root?.end();
		await database?.drop();
	});

	describe('events', () => {
		it('creates the fixture tables with the legacy ON UPDATE attribute', async () => {
			const table = await seedEvents(nextPool('fixture'));
			expect(await showCreate(table)).toMatch(
				/`occurred_on` timestamp NOT NULL DEFAULT current_timestamp\(\) ON UPDATE/i,
			);
		});

		it('reports what a migration does in a dry run, and writes nothing', async () => {
			const pool = nextPool('dry');
			const table = await seedEvents(pool);
			const events = v1Events();
			const before = await schemaDump();

			const report = await migrateEvents({ dryRun: true, pools: [pool] });

			expect(await schemaDump()).toEqual(before);
			expect(report.dryRun).toBe(true);
			expect(report.environment.serverVersion).toMatch(/MariaDB/);
			expect(report.environment.timeZones.process).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
			expect(report.environment.timeZones.server).toEqual(expect.any(String));

			const collection = only(report, table);
			expect(collection).toMatchObject({
				kind: 'events',
				from: 'v1',
				action: 'migrate',
				rows: events.length,
				caseVariantStreams: 1,
				duplicateEventIds: 1,
				nonCrockfordEventIds: nonCanonicalCount(events),
				occurredOnRepair: repairCounts(events),
				droppedIndexes: ['idx_event_date_id'],
				dependents: [],
				blocking: [],
			});
			// The rows of the stream whose ids differ in case only take the id of its lowest version
			expect(collection.canonicalizedStreams).toEqual({
				total: 1,
				rows: 2,
				sample: [{ streamId: 'account-Acc-1', variants: ['account-ACC-1', 'account-acc-1'], rows: 2 }],
			});
			expect(collection.canonicalizedStreams).toEqual(canonicalizedReportOf(events));
			expect(collection.bytes).toBeGreaterThan(0);
			// The gapped stream and the stream that starts at 2; the stream whose ids differ in case only is one stream
			expect(collection.gappedStreams).toEqual({
				total: 2,
				sample: [
					{ streamId: 'account-gap', events: 4, minVersion: 1, maxVersion: 5 },
					{ streamId: 'account-start2', events: 2, minVersion: 2, maxVersion: 3 },
				],
			});
			expect(collection.steps.map(({ name }) => name)).toEqual([
				'session',
				'create-catalog',
				'acquire-lock',
				'drop-copy',
				'create-copy',
				'probe-swap',
				'bulk-load-on',
				'copy',
				'bulk-load-off',
				'swap',
				'catch-up',
				'register',
				'release-lock',
			]);
			expect(collection.steps.every(({ status }) => status === 'pending')).toBe(true);
			expect(collection.steps.find(({ name }) => name === 'swap')?.statement).toBe(
				`RENAME TABLE ${escapeId(table)} TO ${escapeId(`${table}__es_v1`)}, ${escapeId(`${table}__es_v2`)} TO ${escapeId(table)}`,
			);
			expect(collection.warnings.join('\n')).toMatch(/kept as .*__es_v1/);
			expect(collection.warnings.join('\n')).toMatch(
				/1 stream\(s\) have rows whose ids differ in case only, .* 2 row\(s\) take the stream id of their stream's lowest version \(account-ACC-1 -> account-Acc-1, account-acc-1 -> account-Acc-1\)/,
			);
		});

		for (const [charset, tableOptions] of [
			['the default character set', ''],
			['latin1', 'DEFAULT CHARSET=latin1'],
			['utf8mb3', 'DEFAULT CHARSET=utf8mb3'],
		] as const) {
			it(`migrates a table in ${charset}: positions in 3.x order, repaired times, a fence for 3.x, and a store that continues`, async () => {
				const pool = nextPool('ev');
				const table = await seedEvents(pool, { tableOptions });
				const events = v1Events();
				const legacyRows = await root.query(`SELECT * FROM ${escapeId(table)} ORDER BY stream_id, version`);

				const report = await migrateEvents({ pools: [pool] });

				const collection = only(report, table);
				expect(collection).toMatchObject({ from: 'v1', action: 'migrate', rows: events.length, blocking: [] });
				expect(collection.steps.every(({ status }) => status === 'done')).toBe(true);
				// The analysis runs, without the slow occurred_on counts of the dry run
				expect(collection.caseVariantStreams).toBe(1);
				expect(collection.canonicalizedStreams).toEqual(canonicalizedReportOf(events));
				expect(collection.warnings.join('\n')).toMatch(/2 row\(s\) take the stream id of their stream's lowest/);
				expect(collection.occurredOnRepair).toBeUndefined();

				// Positions 1..N, in 3.x's order, each stream in version order (D33), with one stream id per 3.x stream, and
				// the repaired times
				const order = expectedOrder(events);
				const canonical = canonicalOf(events);
				const rows = await root.query<
					{
						stream_id: string;
						version: number;
						aggregate_id: string;
						event_id: string;
						occurred_on: string;
						global_position: string;
					}[]
				>(
					`SELECT stream_id, version, aggregate_id, event_id, CAST(occurred_on AS CHAR) AS occurred_on, CAST(global_position AS CHAR) AS global_position
					 FROM ${escapeId(table)} e ORDER BY e.global_position`,
				);
				expect(rows.map(({ global_position }) => global_position)).toEqual(order.map((_, index) => String(index + 1)));
				expect(rows.map(({ stream_id, version, aggregate_id }) => `${stream_id}@${version} ${aggregate_id}`)).toEqual(
					order.map((event) => {
						const { streamId, aggregateId } = canonical.get(event) as { streamId: string; aggregateId: string };
						return `${streamId}@${event.version} ${aggregateId}`;
					}),
				);
				expect(
					rows
						.filter(({ stream_id }) => stream_id.toLowerCase() === 'account-acc-1')
						.map(({ stream_id, version, aggregate_id }) => `${stream_id}@${version} ${aggregate_id}`),
				).toEqual(['account-Acc-1@1 Acc-1', 'account-Acc-1@2 Acc-1', 'account-Acc-1@3 Acc-1']);
				for (const row of rows) {
					const event = events.find(
						(candidate) => canonical.get(candidate)?.streamId === row.stream_id && candidate.version === row.version,
					);
					expect(`${row.occurred_on.replace(' ', 'T')}Z`, `${row.stream_id}@${row.version}`).toBe(
						repairOf(event as V1EventRow).occurredOn,
					);
				}
				// The inverted stream keeps its version order
				const inverted = rows.filter(({ stream_id }) => stream_id === 'account-inv');
				expect(inverted.map(({ version }) => version)).toEqual([1, 2]);

				// The catalog counts the positions, and the backup keeps the 3.x rows as they were
				expect(
					await root.query(
						`SELECT kind, schema_version, CAST(last_position AS CHAR) AS last FROM ${CATALOG} WHERE name = ?`,
						[table],
					),
				).toEqual([{ kind: 'events', schema_version: 2, last: String(events.length) }]);
				expect(await root.query(`SELECT * FROM ${escapeId(`${table}__es_v1`)} ORDER BY stream_id, version`)).toEqual(
					legacyRows,
				);
				expect(await showCreate(table)).not.toMatch(/ON UPDATE/i);
				expect(await showCreate(table)).toMatch(/COLLATE=utf8mb4_bin/);

				// A 3.x insert fails loudly: the column count doesn't match
				await expect(
					insertV1Events(root, table, [{ ...v1Events()[0], streamId: 'account-late', version: 1 }]),
				).rejects.toMatchObject({ errno: 1136 });

				// A second run has nothing to do
				const again = only(await migrateEvents({ pools: [pool] }), table);
				expect(again).toMatchObject({ from: 'v2', action: 'skip', steps: [] });

				// The store reads the migrated events, and appends after the last position
				const { store } = createEventStore({ ...config() }, getEventMap());
				await store.connect();
				try {
					await store.ensureCollection(pool);
					const all: EventEnvelope[] = [];
					for await (const batch of store.readAll({ pool })) {
						all.push(...batch);
					}
					expect(all.map(({ metadata }) => metadata.globalPosition)).toEqual(
						order.map((_, index) => BigInt(index + 1)),
					);
					expect(all[0].payload).toEqual(order[0].payload);
					expect(all[0].metadata.occurredOn.toISOString()).toBe(repairOf(order[0]).occurredOn);

					// The stream whose ids differed in case only reads as one stream, under the id of its lowest version
					const variant: EventEnvelope[] = [];
					for await (const batch of store.getEnvelopes(EventStream.for(Account, Id.from('Acc-1')), { pool })) {
						variant.push(...batch);
					}
					expect(variant.map(({ metadata }) => [metadata.version, metadata.aggregateId])).toEqual([
						[1, 'Acc-1'],
						[2, 'Acc-1'],
						[3, 'Acc-1'],
					]);
					expect(await store.getStreamVersion(EventStream.for(Account, Id.from('acc-1')), pool)).toBe(0);

					const stream = EventStream.for(Account, AccountId.generate());
					const [appended] = await store.appendEvents(stream, getEvents().slice(0, 1), {
						expectedVersion: ExpectedVersion.NoStream,
						pool,
					});
					expect(appended.metadata.globalPosition).toBe(BigInt(events.length + 1));
				} finally {
					await store.disconnect();
				}
			});
		}

		it('drops the backup with keepBackup: false, and keeps occurred_on as stored with repairOccurredOn: false', async () => {
			const pool = nextPool('opts');
			const table = await seedEvents(pool);

			const report = await migrateEvents({ pools: [pool], keepBackup: false, repairOccurredOn: false });

			expect(only(report, table).steps.map(({ name }) => name)).toContain('drop-backup');
			expect(await tableExists(`${table}__es_v1`)).toBe(false);
			const rows = await root.query<{ stream_id: string; version: number; occurred_on: string }[]>(
				`SELECT stream_id, version, CAST(occurred_on AS CHAR) AS occurred_on FROM ${escapeId(table)}`,
			);
			const events = v1Events();
			const canonical = canonicalOf(events);
			expect(rows).toHaveLength(events.length);
			for (const row of rows) {
				const event = events.find(
					(candidate) => canonical.get(candidate)?.streamId === row.stream_id && candidate.version === row.version,
				);
				expect(row.occurred_on).toBe(`${event?.occurredOn}.000`);
			}
		});

		it('catches up the events that 3.x wrote after the copy, numbered after the others', async () => {
			const pool = nextPool('late');
			const table = await seedEvents(pool);
			const late = lateV1Event();

			const report = await migrateEvents(
				{ pools: [pool] },
				{
					onStepComplete: async (_collection, step) => {
						if (step === 'copy') {
							await insertV1Events(root, table, [late]);
						}
					},
				},
			);

			expect(only(report, table).warnings.join('\n')).toMatch(/1 event\(s\) written by 3\.x during the migration/);
			const [row] = await root.query<{ global_position: string; occurred_on: string }[]>(
				`SELECT CAST(global_position AS CHAR) AS global_position, CAST(occurred_on AS CHAR) AS occurred_on FROM ${escapeId(table)} WHERE stream_id = ? AND version = ?`,
				[late.streamId, late.version],
			);
			expect(row.global_position).toBe(String(v1Events().length + 1));
			expect(`${row.occurred_on.replace(' ', 'T')}Z`).toBe(repairOf(late).occurredOn);
			expect(
				(
					await root.query<{ last: string }[]>(
						`SELECT CAST(last_position AS CHAR) AS last FROM ${CATALOG} WHERE name = ?`,
						[table],
					)
				)[0].last,
			).toBe(String(v1Events().length + 1));
		});

		it('catches up a late event of a stream whose ids differ in case only under the id the copy gave it, also after a crash', async () => {
			const pool = nextPool('latecase');
			const table = await seedEvents(pool);
			const late: V1EventRow = { ...lateV1Event(), streamId: 'account-aCC-1', aggregateId: 'aCC-1' };
			const crash = new Error('crash after swap');

			await expect(
				migrateEvents(
					{ pools: [pool] },
					{
						onStepComplete: async (_collection, step) => {
							if (step === 'copy') {
								await insertV1Events(root, table, [late]);
							}
							if (step === 'swap') {
								throw crash;
							}
						},
					},
				),
			).rejects.toBe(crash);
			const resumed = only(await migrateEvents({ pools: [pool] }), table);

			expect(resumed).toMatchObject({ from: 'v1-partial', action: 'resume', blocking: [] });
			expect(resumed.warnings.join('\n')).toMatch(/1 event\(s\) written by 3\.x during the migration were caught up/);
			const rows = await root.query<
				{ stream_id: string; version: number; aggregate_id: string; global_position: string }[]
			>(
				`SELECT stream_id, version, aggregate_id, CAST(global_position AS CHAR) AS global_position FROM ${escapeId(table)}
				 WHERE stream_id LIKE 'account-acc-1' COLLATE utf8mb4_general_ci ORDER BY version`,
			);
			expect(rows.map(({ stream_id, version, aggregate_id }) => `${stream_id}@${version} ${aggregate_id}`)).toEqual([
				'account-Acc-1@1 Acc-1',
				'account-Acc-1@2 Acc-1',
				'account-Acc-1@3 Acc-1',
				'account-Acc-1@4 Acc-1',
			]);
			expect(rows.at(-1)?.global_position).toBe(String(v1Events().length + 1));
			const [{ total }] = await root.query<{ total: bigint }[]>(`SELECT COUNT(*) AS total FROM ${escapeId(table)}`);
			expect(Number(total)).toBe(v1Events().length + 1);
		});

		it('ends in the same state as a clean run, whatever step a crash interrupts', async () => {
			const reference = await seedEvents(nextPool('clean'));
			const cleanReport = await migrateEvents({ pools: [reference.replace(/-events$/, '')], keepBackup: false });
			const steps = only(cleanReport, reference).steps.map(({ name }) => name);
			const expected = await eventTableDump(reference);
			expect(expected.backup).toBe(false);

			for (const crashAfter of steps) {
				const pool = nextPool('crash');
				const table = await seedEvents(pool);
				const crash = new Error(`crash after ${crashAfter}`);
				await expect(
					migrateEvents(
						{ pools: [pool], keepBackup: false },
						{
							onStepComplete: (_collection, step) => {
								if (step === crashAfter) {
									throw crash;
								}
							},
						},
					),
					`a crash after ${crashAfter}`,
				).rejects.toBe(crash);

				const resumed = only(await migrateEvents({ pools: [pool], keepBackup: false }), table);
				expect(resumed.blocking, `resumed after ${crashAfter}`).toEqual([]);
				expect(await eventTableDump(table), `the table after a crash after ${crashAfter}`).toEqual(expected);
			}
		});

		it('blocks a table with a trigger, a leftover backup, or a migration that is already running, and changes nothing', async () => {
			const triggered = await seedEvents(nextPool('trig'));
			await root.query(
				`CREATE TRIGGER ${escapeId(`${triggered}-audit`)} AFTER INSERT ON ${escapeId(triggered)} FOR EACH ROW SET @audited = 1`,
			);
			const withBackup = await seedEvents(nextPool('bak'));
			await root.query(`CREATE TABLE ${escapeId(`${withBackup}__es_v1`)} (id INT)`);
			const locked = await seedEvents(nextPool('lock'));
			const holder = await rootConnection(database.name);
			const before = await schemaDump();

			try {
				const [{ held }] = await holder.query<{ held: number }[]>(
					"SELECT GET_LOCK(CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', ?))), 0) AS held",
					[locked],
				);
				expect(held).toBe(1);

				const report = await migrateEvents({
					pools: [triggered, withBackup, locked].map((table) => table.replace(/-events$/, '')),
				});

				expect(only(report, triggered)).toMatchObject({
					action: 'blocked',
					blocking: [expect.stringMatching(/trigger .*-audit/)],
				});
				expect(only(report, withBackup)).toMatchObject({
					action: 'blocked',
					blocking: [expect.stringMatching(/backup .*__es_v1 already exists/)],
				});
				expect(only(report, locked)).toMatchObject({
					action: 'blocked',
					blocking: [expect.stringMatching(/Another migration/)],
				});
				expect(await schemaDump()).toEqual(before);
			} finally {
				await holder.end();
			}
		});

		it('fails at the copy while a 3.x transaction holds rows, and migrates once it ended', async () => {
			const pool = nextPool('busy');
			const table = await seedEvents(pool);
			const writer = await rootConnection(database.name);
			try {
				await writer.query("SET SESSION time_zone = '+00:00'");
				await writer.beginTransaction();
				await insertV1Events(writer, table, [lateV1Event()]);

				await expect(migrateEvents({ pools: [pool], lockTimeoutMs: 1000 })).rejects.toThrow(
					/failed at step copy.*Lock wait timeout.*a 3\.x instance\?\): stop it/s,
				);
				// A user with the PROCESS privilege sees the session that holds the rows
				const [{ id }] = await writer.query<{ id: bigint | number }[]>('SELECT CONNECTION_ID() AS id');
				await expect(
					runMigration({ ...mariadbRootConfig(), database: database.name }, 'events', {
						pools: [pool],
						lockTimeoutMs: 1000,
					}),
				).rejects.toThrow(
					new RegExp(
						`failed at step copy.*Sessions with an open transaction, oldest first: .*#${id} root@.*\\(KILL <id> ends one\\)`,
						's',
					),
				);
				expect(only(await migrateEvents({ pools: [pool], dryRun: true }), table).from).toBe('v1');
			} finally {
				await writer.rollback();
				await writer.end();
			}

			expect(only(await migrateEvents({ pools: [pool] }), table)).toMatchObject({ action: 'migrate' });
		});

		it('fails before the copy when the user may not swap the tables, and continues once it may', async () => {
			const pool = nextPool('priv');
			const table = await seedEvents(pool);
			const user = `es_mig_${randomBytes(4).toString('hex')}`;
			const password = randomBytes(12).toString('hex');
			await root.query('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password]);
			try {
				// Without ALTER, which only the swap needs (a missing DROP fails the first step, drop-copy)
				await root.query(`GRANT SELECT, INSERT, UPDATE, CREATE, DROP ON ${escapeId(database.name)}.* TO ?@?`, [
					user,
					'%',
				]);
				const limited = { ...config(), user, password };

				await expect(runMigration(limited, 'events', { pools: [pool] })).rejects.toThrow(
					/failed at step probe-swap: .*denied.*lacks a privilege: it needs SELECT, INSERT, UPDATE, CREATE, ALTER and DROP/s,
				);
				// Nothing was copied: the 3.x table is as it was, next to the empty copy
				expect(only(await migrateEvents({ pools: [pool], dryRun: true }), table).from).toBe('v1');
				const [{ copied }] = await root.query<{ copied: bigint }[]>(
					`SELECT COUNT(*) AS copied FROM ${escapeId(`${table}__es_v2`)}`,
				);
				expect(Number(copied)).toBe(0);
				expect(await tableExists(`${table}__es_vp`)).toBe(false);

				await root.query(`GRANT ALTER ON ${escapeId(database.name)}.* TO ?@?`, [user, '%']);
				expect(only(await runMigration(limited, 'events', { pools: [pool] }), table)).toMatchObject({
					action: 'migrate',
					blocking: [],
				});
			} finally {
				await root.query('DROP USER IF EXISTS ?@?', [user, '%']);
			}
		});

		it('discovers the event tables by their name and columns', async () => {
			const discovery = await createTestDatabase('disc');
			const connection = await rootConnection(discovery.name);
			try {
				await connection.query(v1EventTableDdl('events'));
				await connection.query(v1EventTableDdl('tenant-events'));
				await connection.query(v1EventTableDdl('tenant-events__es_v1'));
				await connection.query('CREATE TABLE `other-events` (id INT)');
				await connection.query(v1EventTableDdl('not-an-event-table'));
				const { store } = createEventStore({ ...discovery.config }, getEventMap());
				await store.connect();
				await store.ensureCollection('fresh');
				await store.disconnect();

				const report = await MariaDBEventStore.migrate({ ...discovery.config }, { dryRun: true });

				expect(report.collections.map(({ name, from, action }) => [name, from, action])).toEqual([
					['events', 'v1', 'migrate'],
					['fresh-events', 'v2', 'skip'],
					['tenant-events', 'v1', 'blocked'],
				]);
			} finally {
				await connection.end();
				await discovery.drop();
			}
		});

		it('refuses 3.x tables in ensureCollection, before and after a swap', async () => {
			const pool = nextPool('ensure');
			const table = await seedEvents(pool);
			for (const ddl of ['auto', 'none'] as const) {
				const { store } = createEventStore({ ...config(), ddl }, getEventMap());
				await store.connect();
				try {
					await expect(store.ensureCollection(pool)).rejects.toMatchObject({
						code: EventSourcingErrorCode.EventStoreSchema,
						found: 'v1',
						remedy: expect.stringMatching(/MariaDBEventStore\.migrate/),
					});
				} finally {
					await store.disconnect();
				}
			}

			// Swapped, not registered yet
			await migrateEvents(
				{ pools: [pool] },
				{
					onStepComplete: (_collection, step) => {
						if (step === 'swap') {
							throw new Error('crash');
						}
					},
				},
			).catch(() => undefined);
			for (const ddl of ['auto', 'none'] as const) {
				const { store } = createEventStore({ ...config(), ddl }, getEventMap());
				await store.connect();
				try {
					await expect(store.ensureCollection(pool)).rejects.toBeInstanceOf(EventStoreSchemaException);
					await expect(store.ensureCollection(pool)).rejects.toMatchObject({
						found: 'v1-partial',
						remedy: expect.stringMatching(/MariaDBEventStore\.migrate/),
					});
				} finally {
					await store.disconnect();
				}
			}
			const { store } = createEventStore({ ...config() }, getEventMap());
			await store.connect();
			try {
				expect(only(await store.migrate({ pools: [pool] }), table)).toMatchObject({
					from: 'v1-partial',
					action: 'resume',
				});
				await expect(store.ensureCollection(pool)).resolves.toBe(table);
			} finally {
				await store.disconnect();
			}
		});

		it('blocks a table that is neither 3.x nor schema v2, and one whose name is too long', async () => {
			const odd = EventCollection.get(nextPool('odd'));
			await root.query(v1EventTableDdl(odd));
			await root.query(`ALTER TABLE ${escapeId(odd)} ADD COLUMN global_position BIGINT NULL`);
			const long = 'x'.repeat(60);

			const report = await migrateEvents({ pools: [odd.replace(/-events$/, ''), long] });

			expect(only(report, odd)).toMatchObject({ from: 'v1-partial', action: 'blocked' });
			expect(only(report, EventCollection.get(long))).toMatchObject({
				action: 'blocked',
				blocking: [expect.stringMatching(/64/)],
			});
		});
	});

	describe('snapshots', () => {
		it('reports the flag damage in a dry run, and writes nothing', async () => {
			const pool = nextPool('sdry');
			const table = await seedSnapshots(pool);
			expect(await showCreate(table)).toMatch(
				/`registered_on` timestamp NOT NULL DEFAULT current_timestamp\(\) ON UPDATE/i,
			);
			const before = await schemaDump();

			const report = await migrateSnapshots({ dryRun: true, pools: [pool] });

			expect(await schemaDump()).toEqual(before);
			const collection = only(report, table);
			expect(collection).toMatchObject({
				kind: 'snapshots',
				from: 'v1',
				action: 'migrate',
				rows: v1Snapshots().length,
				// The stream whose ids differ in case only has two flags: it is one stream, before and after
				snapshotFlags: { duplicateLatest: 2, missingLatest: 1 },
				caseVariantStreams: 1,
				canonicalizedStreams: {
					total: 1,
					rows: 1,
					sample: [{ streamId: 'account-S5', variants: ['Account-s5'], rows: 1 }],
				},
				droppedIndexes: ['idx_aggregate_name_latest'],
				blocking: [],
			});
			expect(collection.steps.map(({ name }) => name)).toEqual([
				'session',
				'create-catalog',
				'acquire-lock',
				'canonicalize',
				'convert',
				'unflag-superseded',
				'flag-latest',
				'add-unique-latest',
				'register',
				'release-lock',
			]);
			const warnings = collection.warnings.join('\n');
			expect(warnings).toMatch(/1 stream\(s\) flag a snapshot other than their highest version/);
			expect(warnings).toMatch(
				/1 snapshot stream\(s\) take the stream id of their lowest snapshot: 1 snapshot\(s\) get another stream id \(Account-s5 -> account-S5\)/,
			);
			expect(warnings).toMatch(/ON UPDATE/);
			expect(warnings).toMatch(/UTC wall time/);
		});

		it('converts the table in place, flags exactly the highest version of every stream, and keeps registered_on', async () => {
			const pool = nextPool('snap');
			const table = await seedSnapshots(pool, { tableOptions: 'DEFAULT CHARSET=latin1' });

			const report = await migrateSnapshots({ pools: [pool] });

			expect(only(report, table)).toMatchObject({ from: 'v1', action: 'migrate', blocking: [] });
			const ddl = await showCreate(table);
			expect(ddl).toMatch(/`registered_on` datetime\(3\) NOT NULL/);
			expect(ddl).not.toMatch(/ON UPDATE/i);
			expect(ddl).toMatch(/UNIQUE KEY `ux_latest` \(`aggregate_name`,`latest`\)/);
			expect(ddl).not.toMatch(/idx_aggregate_name_latest/);
			expect(ddl).toMatch(/COLLATE=utf8mb4_bin/);

			const rows = await root.query<
				{
					stream_id: string;
					version: number;
					aggregate_id: string;
					aggregate_name: string;
					registered_on: string;
					latest: string | null;
				}[]
			>(
				`SELECT stream_id, version, aggregate_id, aggregate_name, CAST(registered_on AS CHAR) AS registered_on, latest
				 FROM ${escapeId(table)} ORDER BY CAST(stream_id AS BINARY), version`,
			);
			// The stream whose ids differed in case only is one stream, flagged on its highest version
			expect(
				rows.filter(({ latest }) => latest !== null).map(({ stream_id, version }) => `${stream_id}@${version}`),
			).toEqual(['account-S5@2', 'account-s1@3', 'account-s2@2', 'account-s3@2', 'account-s4@3']);
			const snapshots = v1Snapshots();
			const canonical = canonicalSnapshotOf(snapshots);
			expect(
				rows.map(({ stream_id, version, aggregate_id, aggregate_name }) => ({
					stream_id,
					version,
					aggregate_id,
					aggregate_name,
				})),
			).toEqual(
				snapshots
					.map((snapshot) => {
						const { streamId, aggregateId, aggregateName } = canonical.get(snapshot) as {
							streamId: string;
							aggregateId: string;
							aggregateName: string;
						};
						return {
							stream_id: streamId,
							version: snapshot.version,
							aggregate_id: aggregateId,
							aggregate_name: aggregateName,
						};
					})
					.sort((a, b) => Buffer.compare(Buffer.from(a.stream_id), Buffer.from(b.stream_id)) || a.version - b.version),
			);
			expect(rows.filter(({ stream_id }) => stream_id === 'account-S5')).toMatchObject([
				{ version: 1, aggregate_id: 'S5', aggregate_name: 'account' },
				{ version: 2, aggregate_id: 'S5', aggregate_name: 'account' },
			]);
			for (const row of rows) {
				expect(row.latest === null || row.latest === `latest#${row.stream_id}`).toBe(true);
				const seeded = snapshots.find(
					(snapshot) => canonical.get(snapshot)?.streamId === row.stream_id && snapshot.version === row.version,
				);
				expect(row.registered_on, `${row.stream_id}@${row.version}`).toBe(`${seeded?.registeredOn}.000`);
			}
			expect(await root.query(`SELECT kind, schema_version FROM ${CATALOG} WHERE name = ?`, [table])).toEqual([
				{ kind: 'snapshots', schema_version: 2 },
			]);

			// The store reads the highest version, and a second run has nothing to do
			const store = createSnapshotStore({ ...config() });
			await store.connect();
			try {
				await store.ensureCollection(pool);
				const last = await store.getLastEnvelope(SnapshotStream.for(Account, Id.from('s4')), pool);
				expect(last?.metadata.version).toBe(3);
				expect(last?.metadata.registeredOn.toISOString()).toBe('2021-05-02T12:00:09.000Z');
				expect(only(await store.migrate({ pools: [pool] }), table)).toMatchObject({ action: 'skip' });
			} finally {
				await store.disconnect();
			}
		});

		describe('with the events of the pool', () => {
			const time = Date.parse('2021-06-01T10:00:00.000Z');
			let eventCount = 0;
			const event = (streamId: string, version: number): V1EventRow => {
				const at = time + ++eventCount * 1000;
				return {
					streamId,
					version,
					event: version === 1 ? 'account-opened' : 'account-credited',
					payload: { version },
					eventId: ulidAt(at, `E${eventCount}`),
					aggregateId: streamId.slice('account-'.length),
					occurredOn: secondsOf(at),
				};
			};
			const snapshot = (streamId: string, version: number, latest: boolean): V1SnapshotRow => ({
				streamId,
				version,
				payload: { version },
				snapshotId: `snap-${streamId}-${version}`,
				aggregateId: streamId.slice('account-'.length),
				registeredOn: `2021-06-01 10:00:0${version}`,
				aggregateName: 'account',
				latest,
			});

			it('gives every snapshot stream the stream id of its events, before and after the events are migrated', async () => {
				const pool = nextPool('align');
				const events = await seedEvents(pool, {
					rows: [
						event('account-Zed-1', 1),
						event('account-zed-1', 2),
						event('account-zed-1', 3),
						event('account-Solo', 1),
					],
				});
				const table = await seedSnapshots(pool, {
					rows: [
						// Ids that differ in case only, neither the id of the events
						snapshot('account-zed-1', 2, true),
						snapshot('account-ZED-1', 3, true),
						// One id, not the id of the events
						snapshot('account-solo', 1, true),
						// No events: the id of the lowest snapshot
						snapshot('account-Lone', 1, false),
						snapshot('account-lone', 2, true),
						snapshot('account-plain', 1, true),
					],
				});
				const expected = {
					total: 3,
					rows: 4,
					sample: [
						{ streamId: 'account-Lone', variants: ['account-lone'], rows: 1 },
						{ streamId: 'account-Solo', variants: ['account-solo'], rows: 1 },
						{ streamId: 'account-Zed-1', variants: ['account-ZED-1', 'account-zed-1'], rows: 2 },
					],
				};

				// From the 3.x event table, before the events are migrated
				const before = only(await migrateSnapshots({ dryRun: true, pools: [pool] }), table);
				expect(before).toMatchObject({ caseVariantStreams: 2, canonicalizedStreams: expected });
				expect(before.steps.find(({ name }) => name === 'canonicalize')?.statement).toContain(
					`FROM ${escapeId(events)} e WHERE e.stream_id = g.stream_id`,
				);
				expect(before.warnings.join('\n')).toMatch(
					new RegExp(
						`3 snapshot stream\\(s\\) take the stream id of their events in ${events}, or without events the id of their lowest snapshot: 4 snapshot\\(s\\) get another stream id`,
					),
				);

				// From the events' backup, after
				expect(only(await migrateEvents({ pools: [pool] }), events)).toMatchObject({ action: 'migrate' });
				const report = only(await migrateSnapshots({ pools: [pool] }), table);
				expect(report).toMatchObject({ action: 'migrate', canonicalizedStreams: expected, blocking: [] });
				expect(report.steps.find(({ name }) => name === 'canonicalize')?.statement).toContain(
					`FROM ${escapeId(`${events}__es_v1`)} e WHERE e.stream_id = g.stream_id`,
				);

				expect(
					(
						await root.query<{ stream_id: string; version: number; aggregate_id: string; latest: string | null }[]>(
							`SELECT stream_id, version, aggregate_id, latest FROM ${escapeId(table)} ORDER BY CAST(stream_id AS BINARY), version`,
						)
					).map(({ stream_id, version, aggregate_id, latest }) => `${stream_id}@${version} ${aggregate_id} ${latest}`),
				).toEqual([
					'account-Lone@1 Lone null',
					'account-Lone@2 Lone latest#account-Lone',
					'account-Solo@1 Solo latest#account-Solo',
					'account-Zed-1@2 Zed-1 null',
					'account-Zed-1@3 Zed-1 latest#account-Zed-1',
					'account-plain@1 plain latest#account-plain',
				]);

				// The stores agree on the ids: the events and the last snapshot of a stream, and one entry per aggregate
				const { store: eventStore } = createEventStore({ ...config() }, getEventMap());
				const snapshotStore = createSnapshotStore({ ...config() });
				await Promise.all([eventStore.connect(), snapshotStore.connect()]);
				try {
					await Promise.all([eventStore.ensureCollection(pool), snapshotStore.ensureCollection(pool)]);
					expect(await eventStore.getStreamVersion(EventStream.for(Account, Id.from('Zed-1')), pool)).toBe(3);
					const last = await snapshotStore.getLastEnvelope(SnapshotStream.for(Account, Id.from('Zed-1')), pool);
					expect(last?.metadata).toMatchObject({ version: 3, aggregateId: 'Zed-1' });
					const latest: string[] = [];
					for await (const batch of snapshotStore.getLastEnvelopesForAggregate(Account, { pool })) {
						latest.push(...batch.map(({ metadata }) => `${metadata.aggregateId}@${metadata.version}`));
					}
					expect(latest).toEqual(['plain@1', 'Zed-1@3', 'Solo@1', 'Lone@2']);
				} finally {
					await Promise.all([eventStore.disconnect(), snapshotStore.disconnect()]);
				}
			});

			it("warns when it can't take the ids of the events: their backup is gone, or they compare in another collation", async () => {
				const dropped = nextPool('gone');
				const droppedEvents = await seedEvents(dropped, {
					rows: [event('account-Zed-1', 1), event('account-zed-1', 2)],
				});
				const droppedSnapshots = await seedSnapshots(dropped, { rows: [snapshot('account-zed-1', 2, true)] });
				// The dry run and the report of the event migration say that the snapshots still need the backup
				const dropping = new RegExp(
					`The snapshot table ${droppedSnapshots} isn't migrated yet: .* read from ${droppedEvents}__es_v1, which keepBackup: false drops`,
				);
				expect(
					only(await migrateEvents({ pools: [dropped], keepBackup: false, dryRun: true }), droppedEvents).warnings.join(
						'\n',
					),
				).toMatch(dropping);
				expect(
					only(await migrateEvents({ pools: [dropped], keepBackup: false }), droppedEvents).warnings.join('\n'),
				).toMatch(dropping);

				const other = nextPool('coll');
				const otherEvents = await seedEvents(other, {
					rows: [event('account-Zed-1', 1)],
					tableOptions: 'DEFAULT CHARSET=latin1',
				});
				const otherSnapshots = await seedSnapshots(other, {
					rows: [snapshot('account-zed-1', 2, true)],
					tableOptions: 'DEFAULT CHARSET=utf8mb4',
				});

				const report = await migrateSnapshots({ pools: [dropped, other] });

				expect(only(report, droppedSnapshots).warnings.join('\n')).toMatch(
					new RegExp(`The 3\\.x events of ${droppedEvents} are gone \\(no ${droppedEvents}__es_v1\\)`),
				);
				expect(only(report, otherSnapshots).warnings.join('\n')).toMatch(
					new RegExp(`don't take the stream ids of the events in ${otherEvents}: its ids compare in latin1_`),
				);
				for (const table of [droppedSnapshots, otherSnapshots]) {
					expect(only(report, table)).toMatchObject({ action: 'migrate', canonicalizedStreams: { total: 0 } });
					expect(
						await root.query(`SELECT stream_id FROM ${escapeId(table)}`),
						`${table} keeps the id of its lowest snapshot`,
					).toEqual([{ stream_id: 'account-zed-1' }]);
				}
			});
		});

		it('ends in the same state as a clean run, whatever step a crash interrupts', async () => {
			const reference = await seedSnapshots(nextPool('sclean'));
			const clean = await migrateSnapshots({ pools: [reference.replace(/-snapshots$/, '')] });
			const steps = only(clean, reference).steps.map(({ name }) => name);
			const expected = await snapshotTableDump(reference);

			for (const crashAfter of steps) {
				const pool = nextPool('scrash');
				const table = await seedSnapshots(pool);
				const crash = new Error(`crash after ${crashAfter}`);
				await expect(
					migrateSnapshots(
						{ pools: [pool] },
						{
							onStepComplete: (_collection, step) => {
								if (step === crashAfter) {
									throw crash;
								}
							},
						},
					),
				).rejects.toBe(crash);

				const resumed = only(await migrateSnapshots({ pools: [pool] }), table);
				expect(resumed.blocking, `resumed after ${crashAfter}`).toEqual([]);
				expect(await snapshotTableDump(table), `the table after a crash after ${crashAfter}`).toEqual(expected);
			}
		});

		it('keeps a 3.x table working until it is migrated', async () => {
			const pool = nextPool('keep');
			const table = await seedSnapshots(pool);
			const store = createSnapshotStore({ ...config() });
			await store.connect();
			const warn = vi.spyOn(store['logger'], 'warn');
			try {
				await expect(store.ensureCollection(pool)).resolves.toBe(table);
				expect(warn).toHaveBeenCalledWith(expect.stringMatching(/3\.x snapshot schema/));
				expect(await root.query(`SELECT kind, schema_version FROM ${CATALOG} WHERE name = ?`, [table])).toEqual([
					{ kind: 'snapshots', schema_version: 1 },
				]);

				const stream = SnapshotStream.for(Account, Id.from('s1'));
				const registeredOn = () =>
					root.query<{ version: number; registered_on: string }[]>(
						`SELECT version, CAST(registered_on AS CHAR) AS registered_on FROM ${escapeId(table)} WHERE stream_id = ? ORDER BY version`,
						[stream.streamId],
					);
				const before = await registeredOn();
				expect(await showCreate(table)).toMatch(/ON UPDATE/i);
				await store.appendSnapshot(stream, 4, { balance: 42 }, pool);
				// Unflagging version 3 didn't let the legacy ON UPDATE attribute overwrite its registered_on
				expect((await registeredOn()).slice(0, before.length)).toEqual(before);
				const last = await store.getLastEnvelope(stream, pool);
				expect(last?.metadata.version).toBe(4);
				expect(last?.payload).toEqual({ balance: 42 });
				const listed: string[] = [];
				for await (const batch of store.listCollections()) {
					listed.push(...batch);
				}
				expect(listed).toContain(table);

				await store.migrate({ pools: [pool] });
				expect(await store.getLastEnvelope(stream, pool)).toMatchObject({ metadata: { version: 4 } });
			} finally {
				await store.disconnect();
			}
		});

		it('blocks a snapshot table with a trigger, and discovers snapshot tables by name and columns', async () => {
			const pool = nextPool('strig');
			const table = await seedSnapshots(pool);
			await root.query(
				`CREATE TRIGGER ${escapeId(`${table}-t`)} BEFORE INSERT ON ${escapeId(table)} FOR EACH ROW SET @x = 1`,
			);

			const report = await migrateSnapshots({ dryRun: true });

			expect(only(report, table)).toMatchObject({ action: 'blocked' });
			expect(only(report, table).blocking).toEqual([expect.stringMatching(/trigger/)]);
			expect(report.collections.every(({ kind }) => kind === 'snapshots')).toBe(true);
			expect(report.collections.map(({ name }) => name)).not.toContain(CATALOG);
		});
	});
	describe('failed steps', () => {
		it('tells how to continue: rerun, stop 3.x, or copy in READ COMMITTED when the locks outgrow the buffer pool', () => {
			expect(failureHint('swap', new Error('boom'))).toBe('Run the migration again: it continues where it stopped.');
			expect(failureHint('copy', { errno: 1205 })).toMatch(/^A session still uses the table/);
			const full = failureHint('copy', { errno: 1206 });
			expect(full).toMatch(/increase innodb_buffer_pool_size and run the migration again/);
			expect(full).toMatch(/READ COMMITTED before the copy/);
			expect(failureHint('convert', { errno: 1206 })).toBe('Run the migration again: it continues where it stopped.');
		});
	});
});
