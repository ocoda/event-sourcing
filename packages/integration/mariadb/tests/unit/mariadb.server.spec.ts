import type { Logger } from '@nestjs/common';
import { mariadbTestFlavor } from '@ocoda/event-sourcing-testing/unit';
import type { Queryable } from '../../lib/mariadb.schema.js';
import {
	type MariaDBDeployment,
	type MariaDBServer,
	capabilitiesOf,
	probeDeployment,
	probeServer,
	warnDeploymentOnce,
} from '../../lib/mariadb.server.js';
import { rootConnection } from '../support/stores.js';

const answering = (version: string, comment: string | null) =>
	({ query: vi.fn(async () => [{ version, comment }]) }) as unknown as Queryable;

describe(probeServer, () => {
	it.each([
		{ version: '10.11.14-MariaDB-ubu2204', comment: 'mariadb.org binary distribution', flavour: 'mariadb' },
		{ version: '11.4.5-MariaDB', comment: 'MariaDB Server', flavour: 'mariadb' },
		{ version: '10.6.20-16-MariaDB-enterprise', comment: 'MariaDB Enterprise Server', flavour: 'mariadb' },
		{ version: '8.4.11', comment: 'MySQL Community Server - GPL', flavour: 'mysql' },
		{ version: '9.7.2', comment: 'MySQL Community Server - GPL', flavour: 'mysql' },
		{ version: '8.0.39-30', comment: 'Percona Server (GPL), Release 30, Revision 0d8e3e3c', flavour: 'mysql' },
	])('$version ($comment) speaks $flavour', async ({ version, comment, flavour }) => {
		await expect(probeServer(answering(version, comment))).resolves.toEqual({ version, comment, flavour });
	});

	it('reads a missing comment as empty, and throws what the query throws', async () => {
		await expect(probeServer(answering('8.4.11', null))).resolves.toMatchObject({ comment: '', flavour: 'mysql' });
		const lost = Object.assign(new Error('connection lost'), { errno: 45009, fatal: true });
		await expect(
			probeServer({
				query: vi.fn(async () => {
					throw lost;
				}),
			} as unknown as Queryable),
		).rejects.toBe(lost);
	});

	it('finds the server that ES_TEST_MARIADB_FLAVOR names, so a MySQL run cannot pass as a MariaDB one', async () => {
		const connection = await rootConnection();
		try {
			await expect(probeServer(connection)).resolves.toMatchObject({ flavour: mariadbTestFlavor() });
		} finally {
			await connection.end();
		}
	});
});

/** A server that knows the given system variables, and answers 1193 for any other. */
const withVariables = (variables: Record<string, unknown>) =>
	({
		query: vi.fn(async (sql: string) => {
			const name = /^SELECT @@(\w+) AS value$/.exec(sql)?.[1] ?? '';
			if (!(name in variables)) {
				throw Object.assign(new Error(`Unknown system variable '${name}'`), { errno: 1193 });
			}
			return [{ value: variables[name] }];
		}),
	}) as unknown as Queryable;

describe(probeDeployment, () => {
	const mysql = { version: '8.4.11', comment: 'MySQL Community Server - GPL', flavour: 'mysql' } as const;
	const mariadb = { version: '11.4.5-MariaDB', comment: 'MariaDB Server', flavour: 'mariadb' } as const;
	const galera = '/usr/lib/galera/libgalera_smm.so';

	it.each<{
		deploymentOf: string;
		server: MariaDBServer;
		variables: Record<string, unknown>;
		deployment: MariaDBDeployment;
	}>([
		{ deploymentOf: 'MariaDB', server: mariadb, variables: { wsrep_on: 0 }, deployment: { kind: 'innodb' } },
		{ deploymentOf: 'MySQL', server: mysql, variables: {}, deployment: { kind: 'innodb' } },
		{
			deploymentOf: 'MariaDB Galera Cluster',
			server: mariadb,
			variables: { wsrep_on: 'ON', wsrep_provider: galera },
			deployment: { kind: 'galera' },
		},
		{
			deploymentOf: 'Percona XtraDB Cluster',
			server: mysql,
			variables: { wsrep_on: 1, wsrep_provider: galera },
			deployment: { kind: 'galera' },
		},
		{
			deploymentOf: 'MariaDB with wsrep_on=ON and no provider',
			server: mariadb,
			variables: { wsrep_on: 1, wsrep_provider: 'none' },
			deployment: { kind: 'innodb' },
		},
		...[1, 1n, '1', 'ON', true].map((value) => ({
			deploymentOf: `MySQL Group Replication, single-primary (${String(value)})`,
			server: mysql,
			variables: { group_replication_single_primary_mode: value },
			deployment: { kind: 'innodb' } as const,
		})),
		...[0, 0n, '0', 'OFF', false].map((value) => ({
			deploymentOf: `MySQL Group Replication, multi-primary (${String(value)})`,
			server: mysql,
			variables: { group_replication_single_primary_mode: value },
			deployment: { kind: 'group-replication' } as const,
		})),
		{
			deploymentOf: 'MySQL Group Replication, a value that is neither',
			server: mysql,
			variables: { group_replication_single_primary_mode: null },
			deployment: { kind: 'innodb' },
		},
		{
			deploymentOf: 'TiDB, pessimistic',
			server: mysql,
			variables: { tidb_txn_mode: 'pessimistic' },
			deployment: { kind: 'tidb' },
		},
		{
			deploymentOf: 'TiDB, optimistic (empty)',
			server: mysql,
			variables: { tidb_txn_mode: '' },
			deployment: { kind: 'tidb' },
		},
		// Not a string: a proxy that answers an unknown variable with NULL is no TiDB
		{
			deploymentOf: 'a NULL tidb_txn_mode',
			server: mysql,
			variables: { tidb_txn_mode: null },
			deployment: { kind: 'innodb' },
		},
		// vtgate answers @@transaction_mode itself, and passes an unknown variable on to the MySQL behind it
		{
			deploymentOf: 'Vitess, MULTI',
			server: mysql,
			variables: { transaction_mode: 'MULTI' },
			deployment: { kind: 'vitess', transactionMode: 'MULTI' },
		},
		{
			deploymentOf: 'Vitess, TWOPC',
			server: mysql,
			variables: { transaction_mode: 'twopc', wsrep_on: 0 },
			deployment: { kind: 'vitess', transactionMode: 'TWOPC' },
		},
		{
			deploymentOf: "a vtgate that doesn't answer transaction_mode, by its version",
			server: { version: '8.0.40-Vitess', comment: '', flavour: 'mysql' },
			variables: {},
			deployment: { kind: 'vitess', transactionMode: 'MULTI' },
		},
		{
			deploymentOf: "a vtgate that doesn't answer transaction_mode, by its comment",
			server: {
				version: '8.0.40',
				comment: "Version: 22.0.1 (Git revision 1a2b3c branch 'HEAD') built on Tue Jun 3 2025",
				flavour: 'mysql',
			},
			variables: {},
			deployment: { kind: 'vitess', transactionMode: 'MULTI' },
		},
	])('$deploymentOf is $deployment.kind', async ({ server, variables, deployment }) => {
		await expect(probeDeployment(withVariables(variables), server)).resolves.toEqual(deployment);
	});

	it('throws what a probe throws other than 1193, such as a lost connection', async () => {
		const lost = Object.assign(new Error('connection lost'), { errno: 45009, fatal: true });
		await expect(
			probeDeployment(
				{
					query: vi.fn(async () => {
						throw lost;
					}),
				} as unknown as Queryable,
				mysql,
			),
		).rejects.toBe(lost);
	});

	it('finds one InnoDB server in the test database, which is neither TiDB, Vitess, Galera nor multi-primary', async () => {
		const connection = await rootConnection();
		try {
			await expect(probeDeployment(connection, await probeServer(connection))).resolves.toEqual({ kind: 'innodb' });
		} finally {
			await connection.end();
		}
	});
});

describe(capabilitiesOf, () => {
	it.each<[MariaDBDeployment, boolean, 'gap-safe' | 'best-effort']>([
		[{ kind: 'innodb' }, true, 'gap-safe'],
		[{ kind: 'galera' }, true, 'best-effort'],
		[{ kind: 'group-replication' }, true, 'best-effort'],
		[{ kind: 'tidb' }, true, 'best-effort'],
		[{ kind: 'vitess', transactionMode: 'MULTI' }, false, 'best-effort'],
		[{ kind: 'vitess', transactionMode: 'SINGLE' }, true, 'best-effort'],
		[{ kind: 'vitess', transactionMode: 'TWOPC' }, true, 'best-effort'],
		[{ kind: 'vitess', transactionMode: 'SOMETHING-NEW' }, false, 'best-effort'],
	])('%o: atomicAppend %s, globalOrder %s', (deployment, atomicAppend, globalOrder) => {
		expect(capabilitiesOf(deployment)).toEqual({ atomicAppend, headers: true, globalOrder });
	});
});

describe(warnDeploymentOnce, () => {
	it('warns once per process and kind, and never for one InnoDB server', () => {
		const logger = { warn: vi.fn() } as unknown as Logger;
		warnDeploymentOnce({ kind: 'innodb' }, logger);
		warnDeploymentOnce({ kind: 'group-replication' }, logger);
		warnDeploymentOnce({ kind: 'group-replication' }, logger);
		warnDeploymentOnce({ kind: 'vitess', transactionMode: 'MULTI' }, logger);

		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenNthCalledWith(1, expect.stringMatching(/Group Replication .* 'best-effort'/));
		expect(logger.warn).toHaveBeenNthCalledWith(2, expect.stringMatching(/Vitess .* not atomic/));
	});
});
