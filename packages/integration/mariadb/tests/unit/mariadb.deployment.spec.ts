import { EventCollection, EventStream } from '@ocoda/event-sourcing';
import { Account, AccountId, getEventMap, getEvents } from '@ocoda/event-sourcing-testing/unit';
import type { Pool } from 'mariadb';
import { createEventStore, dropTables, poolOf } from '../support/stores.js';

// The event store on a server that probeDeployment() takes for TiDB, on the test database: the capabilities, the
// warning and the read path follow the deployment. (The probe itself: mariadb.server.spec.ts.)
vi.mock('../../lib/mariadb.server.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/mariadb.server.js')>()),
	probeDeployment: vi.fn(async () => ({ kind: 'tidb' })),
}));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
	const all: T[] = [];
	for await (const batch of generator) {
		all.push(...batch);
	}
	return all;
};

describe('MariaDBEventStore on a deployment that is not one InnoDB server (TiDB)', () => {
	it("reports 'best-effort', warns once per process, and reads the high-water mark without a lock", async () => {
		const first = createEventStore({}, getEventMap()).store;
		const second = createEventStore({}, getEventMap()).store;
		const warn = vi.spyOn(first['logger'], 'warn').mockImplementation(() => undefined);
		const warnSecond = vi.spyOn(second['logger'], 'warn').mockImplementation(() => undefined);
		await first.connect();
		await second.connect();
		const collection = EventCollection.get('tidb-like');
		const pool: Pool = poolOf(first);
		try {
			expect(first.capabilities).toEqual({ atomicAppend: true, headers: true, globalOrder: 'best-effort' });
			expect([...warn.mock.calls, ...warnSecond.mock.calls]).toEqual([[expect.stringMatching(/^TiDB is not InnoDB/)]]);

			await first.ensureCollection('tidb-like');
			const [event] = getEvents();
			for (let index = 0; index < 3; index++) {
				await first.appendEvents(EventStream.for(Account, AccountId.generate()), [event], {
					expectedVersion: 0,
					pool: 'tidb-like',
				});
			}
			// A permanent gap at the start: the reader settles it under the high-water mark
			await pool.query(`DELETE FROM ${pool.escapeId(collection)} WHERE global_position = 1`);
			const query = vi.spyOn(pool, 'query');

			const read = await drain(first.readAll({ pool: 'tidb-like' }));

			expect(read.map(({ metadata }) => metadata.globalPosition)).toEqual([2n, 3n]);
			const highWaterMark = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('last_position'));
			expect(highWaterMark).toHaveLength(1);
			expect(highWaterMark[0]).not.toContain('LOCK IN SHARE MODE');
		} finally {
			await dropTables(pool, [collection]);
			await Promise.all([first.disconnect(), second.disconnect()]);
		}
	});
});
