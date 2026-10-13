import type { Logger } from '@nestjs/common';
import type { EventStoreCapabilities } from '@ocoda/event-sourcing';
import type { Queryable } from './mariadb.schema.js';
import { isGaleraNode, isOff, systemVariableOf } from './mariadb.utils.js';

/**
 * The SQL dialect of a server: MariaDB, or MySQL (and the servers that speak its dialect, such as Percona Server).
 */
export type ServerFlavour = 'mariadb' | 'mysql';

/** What the stores know about the server they connect to. */
export interface MariaDBServer {
	/** `@@version`, such as `11.4.5-MariaDB` or `8.4.11`. */
	version: string;
	/** `@@version_comment`, such as `MariaDB Server` or `MySQL Community Server - GPL`. */
	comment: string;
	flavour: ServerFlavour;
}

/**
 * Asks the server what it is. MariaDB names itself in its version (`11.4.5-MariaDB-ubu2404`) or its comment; every
 * other server is taken to speak MySQL's dialect.
 * @throws what the query throws, such as a connection error
 */
export const probeServer = async (db: Queryable): Promise<MariaDBServer> => {
	const [{ version, comment }] = await db.query<{ version: string; comment: string | null }[]>(
		'SELECT @@version AS version, @@version_comment AS comment',
	);
	const flavour: ServerFlavour = /mariadb/i.test(`${version} ${comment ?? ''}`) ? 'mariadb' : 'mysql';
	return { version, comment: comment ?? '', flavour };
};

/**
 * What the event store's server is, as far as the order of its commits goes:
 * - `'innodb'`: one InnoDB server, or the primary of a replica set. Appends serialize on the counter row's lock, and
 *   commit in the order of their positions.
 * - `'galera'`: a Galera node (MariaDB Galera Cluster, Percona XtraDB Cluster), whose row locks don't order the commits
 *   of the other nodes.
 * - `'group-replication'`: a member of a MySQL Group Replication group in multi-primary mode, whose row locks don't
 *   order the commits of the other members either.
 * - `'tidb'`: TiDB, which speaks MySQL but is no InnoDB: `LOCK IN SHARE MODE` is refused (1235) or takes no lock.
 * - `'vitess'`: a Vitess `vtgate` (PlanetScale), which commits a transaction that spans shards shard by shard
 *   (`transaction_mode` `MULTI`), and reads every shard at a snapshot of its own.
 */
export type MariaDBDeployment =
	| { kind: 'innodb' }
	| { kind: 'galera' }
	| { kind: 'group-replication' }
	| { kind: 'tidb' }
	| { kind: 'vitess'; transactionMode: string };

/**
 * Tells the deployments apart by variables only one of them has (an unknown variable is 1193): `@@tidb_txn_mode` is
 * TiDB's, `@@transaction_mode` is answered by `vtgate` itself, a Galera node has `@@wsrep_on` on and a provider loaded
 * (`isGaleraNode`), and `@@group_replication_single_primary_mode` exists while the Group Replication plugin is loaded
 * (explicitly off: multi-primary). Variables rather than `@@version`, which TiDB, Vitess and MariaDB let an operator
 * change. Only a `vtgate` that doesn't answer `@@transaction_mode` is told by `server`'s version or comment.
 * @throws what a query throws other than 1193, such as a connection error
 */
export const probeDeployment = async (db: Queryable, server: MariaDBServer): Promise<MariaDBDeployment> => {
	if (typeof (await systemVariableOf(db, 'tidb_txn_mode')) === 'string') {
		return { kind: 'tidb' };
	}
	const transactionMode = await systemVariableOf(db, 'transaction_mode');
	if (transactionMode !== undefined && transactionMode !== null) {
		return { kind: 'vitess', transactionMode: String(transactionMode).toUpperCase() };
	}
	if (/-vitess/i.test(server.version) || /^Version: \S+.*\(Git revision /.test(server.comment)) {
		return { kind: 'vitess', transactionMode: 'MULTI' };
	}
	if (await isGaleraNode(db)) {
		return { kind: 'galera' };
	}
	if (isOff(await systemVariableOf(db, 'group_replication_single_primary_mode'))) {
		return { kind: 'group-replication' };
	}
	return { kind: 'innodb' };
};

/**
 * The capabilities of the event store on a deployment (ADR 0002 §3): `'gap-safe'` rests on one InnoDB server ordering
 * the commits by the counter row's lock, so every other deployment gets `'best-effort'`. Appends stay atomic, except
 * on Vitess outside `transaction_mode` `SINGLE` and `TWOPC`: with `MULTI` (the default) a transaction that spans
 * shards commits shard by shard, and the counter and the events can sit on different shards.
 */
export const capabilitiesOf = (deployment: MariaDBDeployment): Required<EventStoreCapabilities> => {
	switch (deployment.kind) {
		case 'innodb':
			return { atomicAppend: true, headers: true, globalOrder: 'gap-safe' };
		case 'vitess':
			return {
				atomicAppend: ['SINGLE', 'TWOPC'].includes(deployment.transactionMode),
				headers: true,
				globalOrder: 'best-effort',
			};
		default:
			return { atomicAppend: true, headers: true, globalOrder: 'best-effort' };
	}
};

const WARNINGS: Record<Exclude<MariaDBDeployment['kind'], 'innodb'>, string> = {
	galera: "Galera (wsrep_on) orders the global positions per node only: globalOrder is 'best-effort' on this cluster",
	'group-replication':
		"MySQL Group Replication in multi-primary mode orders the global positions per member only: globalOrder is 'best-effort'. Single-primary mode is 'gap-safe' on the primary.",
	tidb: "TiDB is not InnoDB, and its locking reads don't wait for an append in flight: globalOrder is 'best-effort'. TiDB is not a tested server of this store.",
	vitess:
		"Vitess commits a transaction that spans shards shard by shard, and reads every shard at a snapshot of its own: globalOrder is 'best-effort', and with transaction_mode MULTI (the default) appends are not atomic. Vitess is not a tested server of this store.",
};

const warned = new Set<MariaDBDeployment['kind']>();

/** Warns once per process and deployment kind that the store's guarantees are weaker on it. */
export const warnDeploymentOnce = (deployment: MariaDBDeployment, logger: Logger): void => {
	if (deployment.kind === 'innodb' || warned.has(deployment.kind)) {
		return;
	}
	warned.add(deployment.kind);
	logger.warn(WARNINGS[deployment.kind]);
};
