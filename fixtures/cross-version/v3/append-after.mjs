// A 3.0.2 append after the master reader ran: one event to a new stream in every event pool of the manifest.
//
// Before schema v2 the 3.x tables still take 3.x writes. Once a driver migrates to schema v2, a forgotten 3.x writer
// must fail loudly instead of writing rows without positions (the fence).
//
//   node append-after.mjs --database <db> --namespace xv_<run> [--url <mongodb url>] --manifest <manifest.json>
//
// Exit codes: 0 = every append succeeded; 2 = the database refused every append (3.x reports an
// EventStorePersistenceException); 1 = anything else (a mix, another error, or the script failed).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
	DefaultEventSerializer,
	EventMap,
	EventStorePersistenceException,
	EventStream,
	Id,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import { MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import { PostgresEventStore } from '@ocoda/event-sourcing-postgres';
import { Account, NoteAdded } from './domain.mjs';
import { parseDatabase, parseNamespace, storeOptions } from './namespace.mjs';

const EVENT_STORES = { postgres: PostgresEventStore, mariadb: MariaDBEventStore, mongodb: MongoDBEventStore };

const main = async () => {
	const { values } = parseArgs({
		options: {
			database: { type: 'string' },
			namespace: { type: 'string' },
			url: { type: 'string' },
			manifest: { type: 'string' },
		},
	});
	const database = parseDatabase(values.database);
	const target = { database, namespace: parseNamespace(values.namespace), url: values.url };
	const manifest = JSON.parse(readFileSync(values.manifest, 'utf8'));

	const eventMap = new EventMap();
	eventMap.register(NoteAdded, DefaultEventSerializer.for(NoteAdded));
	const store = new EVENT_STORES[database](eventMap, storeOptions(target));
	store.publish = () => undefined;
	await store.connect();

	const outcomes = [];
	try {
		for (const { pool, collection } of manifest.eventPools) {
			const stream = EventStream.for(Account, Id.from(randomUUID()));
			try {
				await store.appendEvents(
					stream,
					1,
					[new NoteAdded('appended by 3.0.2 after the master reader')],
					pool ?? undefined,
				);
				outcomes.push({ collection, outcome: 'appended' });
			} catch (error) {
				// 3.x keeps the database error only as the stack of its EventStorePersistenceException.
				outcomes.push({
					collection,
					outcome: error instanceof EventStorePersistenceException ? 'refused' : 'failed',
					error: `${error?.name}: ${error?.message}`,
					cause: String(error?.stack ?? '').split('\n')[0],
				});
			}
		}
	} finally {
		await store.disconnect();
	}

	for (const outcome of outcomes) console.log(JSON.stringify(outcome));
	if (outcomes.every(({ outcome }) => outcome === 'appended')) return 0;
	if (outcomes.every(({ outcome }) => outcome === 'refused')) return 2;
	return 1;
};

process.exitCode = await main().catch((error) => {
	console.error(error);
	return 1;
});
