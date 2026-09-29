import type { Logger } from '@nestjs/common';
import type { EventStoreCapabilities } from '@ocoda/event-sourcing';
import type { MongoClient } from 'mongodb';

/**
 * The kind of deployment a store is connected to.
 * - `'replica-set'`: transactions, so appends are atomic and the global order is gap-safe (also a single-node replica
 *   set);
 * - `'sharded'`: a `mongos`; transactions, but the visibility of positions across shards is unproven;
 * - `'standalone'`: no transactions.
 */
export type MongoDBTopology = 'standalone' | 'replica-set' | 'sharded';

/**
 * Asks the server what it is (`hello`). The store chooses its append path by it: on a standalone server, a transaction
 * fails with a driver error ("does not support retryable writes") that is no usable signal.
 */
export const detectTopology = async (client: MongoClient): Promise<MongoDBTopology> => {
	const hello = await client.db('admin').command({ hello: 1 });
	if (hello.msg === 'isdbgrid') {
		return 'sharded';
	}
	return hello.setName ? 'replica-set' : 'standalone';
};

/**
 * The capabilities of the event store per topology (ADR 0002 §4). `'gap-safe'` rests on the transaction that updates
 * the pool's counter first, and on majority reads; only replica sets have the evidence (`read-all-gap-safe`).
 */
export const capabilitiesOf = (topology: MongoDBTopology): Required<EventStoreCapabilities> => {
	switch (topology) {
		case 'replica-set':
			return { atomicAppend: true, headers: true, globalOrder: 'gap-safe' };
		case 'sharded':
			return { atomicAppend: true, headers: true, globalOrder: 'best-effort' };
		default:
			return { atomicAppend: false, headers: true, globalOrder: 'best-effort' };
	}
};

let warnedStandalone = false;

/**
 * Warns once per process that a standalone server can't give atomic appends or a gap-safe order.
 */
export const warnStandaloneOnce = (logger: Logger): void => {
	if (warnedStandalone) {
		return;
	}
	warnedStandalone = true;
	logger.warn(
		'Connected to a standalone MongoDB server: appends are not atomic, a failed append leaves holes in the global positions, and readAll may miss events that commit late (globalOrder: best-effort). Run MongoDB as a replica set (a single-node replica set is enough) for atomic appends and a gap-safe global order.',
	);
};
