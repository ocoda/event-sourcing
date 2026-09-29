import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { EventId, EventStream, SnapshotStream } from '@ocoda/event-sourcing';
import { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { Account, AccountId, mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { type CollectionInfo, type Db, type Document, MongoClient } from 'mongodb';
import {
	createV1EventCollection,
	createV1SnapshotCollection,
	v1EventDocument,
	v1SnapshotDocument,
} from '../fixtures/schema-v1.js';
import { CATALOG } from '../support/catalog.js';

// migrations/4.0.mongosh.js run by mongosh against 3.x collections, next to migrate() on the same data: both leave the
// same collections. Runs where mongosh is installed (the MongoDB images and most developer machines have it).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SCRIPT = resolve(import.meta.dirname, '../../migrations/4.0.mongosh.js');
const hasMongosh = spawnSync('mongosh', ['--version'], { encoding: 'utf8' }).status === 0;

/** A URL of the same server with another database. */
const withDatabase = (url: string, database: string): string => {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
};

const runScript = (url: string) => spawnSync('mongosh', [url, '--quiet', '--file', SCRIPT], { encoding: 'utf8' });

/** 3.x data of the default pools: an inverted stream, a gapped one, optionally a non-canonical id, damaged flags. */
const corpus = (nonCanonical: boolean) => {
	const t0 = Date.UTC(2021, 0, 31, 23, 59, 59, 990);
	const idAt = (time: number) => EventId.generate(new Date(time)).value;
	const [a, b, inverted] = Array.from({ length: 3 }, () => EventStream.for(Account, AccountId.generate()));
	const [low, high] = [idAt(t0 + 50), idAt(t0 + 50)].sort();
	const events = [
		...[1, 2, 3].map((version) => v1EventDocument(a, version, { eventId: idAt(t0 + version * 7) })),
		...[1, 2, 4].map((version) => v1EventDocument(b, version, { eventId: idAt(t0 + version * 7) })),
		v1EventDocument(inverted, 1, { eventId: high }),
		v1EventDocument(inverted, 2, { eventId: low }),
		...(nonCanonical ? [v1EventDocument(a, 4, { eventId: idAt(t0 + 1).toLowerCase() })] : []),
	];
	const [healthy, duplicate, missing] = Array.from({ length: 3 }, () =>
		SnapshotStream.for(Account, AccountId.generate()),
	);
	const snapshots = [
		v1SnapshotDocument(healthy, 1, false),
		v1SnapshotDocument(healthy, 2, true),
		v1SnapshotDocument(duplicate, 1, true),
		v1SnapshotDocument(duplicate, 2, true),
		v1SnapshotDocument(missing, 1, false),
	];
	return { events, snapshots };
};

describe.runIf(hasMongosh).each(mongodbTestTopologies())(
	'migrations/4.0.mongosh.js run by mongosh ($name)',
	({ url }) => {
		let client: MongoClient;
		const databases: string[] = [];

		const seed = async ({ events, snapshots }: ReturnType<typeof corpus>) => {
			const name = `es_mgo_script_${randomBytes(4).toString('hex')}`;
			databases.push(name);
			const db = client.db(name);
			await createV1EventCollection(db, 'events');
			await db.collection('events').insertMany(events.map((event) => ({ ...event })) as Document[]);
			await createV1SnapshotCollection(db, 'snapshots');
			await db.collection('snapshots').insertMany(snapshots.map((snapshot) => ({ ...snapshot })) as Document[]);
			return { name, db, url: withDatabase(url, name) };
		};

		/** The collections of the default pools and their catalog documents, as the migration leaves them. */
		const dump = async (db: Db) => {
			const collections = (await db
				.listCollections({ name: { $in: ['events', 'snapshots'] } })
				.toArray()) as CollectionInfo[];
			const shapes: Document[] = [];
			for (const { name, options } of collections.sort((x, y) => x.name.localeCompare(y.name))) {
				const indexes = (await db.collection(name).indexes())
					.map(({ name: index, key, unique, partialFilterExpression }) => ({
						index,
						key,
						unique,
						partialFilterExpression,
					}))
					.sort((x, y) => String(x.index).localeCompare(String(y.index)));
				const documents = await db.collection(name).find({}, { promoteLongs: false }).sort({ _id: 1 }).toArray();
				shapes.push({ name, options, indexes, documents });
			}
			const catalog = await db.collection(CATALOG).find({}).sort({ _id: 1 }).toArray();
			return { shapes, catalog };
		};

		beforeAll(async () => {
			client = await new MongoClient(url).connect();
		});

		afterAll(async () => {
			for (const name of databases) {
				await client.db(name).dropDatabase();
			}
			await client.close();
		});

		it.each([
			['canonical event ids (numbered by _id)', false],
			['a non-canonical event id (numbered by eventDate, _id)', true],
		])('leaves the same collections as migrate(), with %s', async (_, nonCanonical) => {
			const data = corpus(nonCanonical);
			const [byScript, byMigrate] = [await seed(data), await seed(data)];

			const run = runScript(byScript.url);
			expect(run.status, `mongosh failed: ${run.stderr}`).toBe(0);
			expect(run.stdout).toContain('2 of 2 collections registered with schema version 2');
			await MongoDBEventStore.migrate({ url: byMigrate.url });
			await MongoDBSnapshotStore.migrate({ url: byMigrate.url });

			const migrated = await dump(byScript.db);
			expect(migrated).toEqual(await dump(byMigrate.db));
			expect(migrated.catalog.map(({ _id }) => _id)).toEqual(['events', 'snapshots']);
			expect(
				await byScript.db
					.collection('events')
					.countDocuments({ globalPosition: { $type: 'long' }, eventDate: { $exists: false } }),
			).toBe(data.events.length);
		});

		it('checks what blocks the migration before it writes anything', async () => {
			const { db, url: scriptUrl } = await seed(corpus(false));
			await db.command({ collMod: 'events', validator: { version: { $gte: 1 } } });
			await db.collection('events').insertOne({ _id: 1 as never, streamId: 's', version: 1, eventDate: '2021-01' });
			const before = await dump(db);

			const run = runScript(scriptUrl);

			expect(run.status).not.toBe(0);
			expect(`${run.stdout}${run.stderr}`).toContain('Nothing was migrated');
			expect(`${run.stdout}${run.stderr}`).toContain('events has a validator');
			expect(`${run.stdout}${run.stderr}`).toContain('event ids that are not strings');
			expect(await dump(db)).toEqual(before);
		});
	},
);
