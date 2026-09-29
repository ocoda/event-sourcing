import type { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import {
	collect,
	createCrossVersionEventMap,
	expectEventStreamReads,
	expectLegacyAllOrder,
	expectListedCollections,
	expectSnapshotStreamReads,
	expectWriterTimeZone,
	loadCrossVersionManifest,
	poolOf,
} from '@ocoda/event-sourcing-testing/cross-version';
import { createEventStore, createSnapshotStore } from '../support/stores.js';

// The published 3.0.2 packages wrote a corpus into a database of its own (fixtures/cross-version/v3/writer.mjs) and
// recorded what 3.0.2 read back. This driver must read the same data the same way. Run through
// `pnpm test:cross-version --database mariadb` (scripts/test-cross-version.mjs).
const manifest = loadCrossVersionManifest();
const overrides = { database: manifest.namespace };

describe('MariaDB reads the 3.0.2 corpus as 3.0.2 did', () => {
	let eventStore: MariaDBEventStore;
	let snapshotStore: MariaDBSnapshotStore;

	beforeAll(async () => {
		expectWriterTimeZone(manifest);
		eventStore = createEventStore(overrides, createCrossVersionEventMap()).store;
		snapshotStore = createSnapshotStore(overrides);
		await Promise.all([eventStore.connect(), snapshotStore.connect()]);
	});

	afterAll(async () => {
		await Promise.all([eventStore?.disconnect(), snapshotStore?.disconnect()]);
	});

	describe.each(manifest.eventPools)('$collection', (pool) => {
		it('returns every stream as 3.0.2 did (getEnvelopes, getEvents)', async () => {
			for (const stream of pool.streams) {
				await expectEventStreamReads(eventStore, stream, poolOf(pool.pool));
			}
		});

		it('returns the pool in the 3.0.2 order (getAllEnvelopes)', async () => {
			const envelopes = await collect(
				eventStore.getAllEnvelopes({ pool: poolOf(pool.pool), since: manifest.allEnvelopesSince }),
			);
			expectLegacyAllOrder(envelopes, pool.legacyAllOrder);
		});
	});

	describe.each(manifest.snapshotPools)('$collection', (pool) => {
		it('returns every snapshot stream as 3.0.2 did (getEnvelopes, getLastEnvelope)', async () => {
			for (const stream of pool.streams) {
				await expectSnapshotStreamReads(snapshotStore, stream, pool);
			}
		});
	});

	it('lists the collections as 3.0.2 did', async () => {
		expectListedCollections(
			await collect(eventStore.listCollections()),
			manifest.eventCollections,
			manifest.eventPools.map(({ collection }) => collection),
		);
		expectListedCollections(
			await collect(snapshotStore.listCollections()),
			manifest.snapshotCollections,
			manifest.snapshotPools.map(({ collection }) => collection),
		);
	});
});
