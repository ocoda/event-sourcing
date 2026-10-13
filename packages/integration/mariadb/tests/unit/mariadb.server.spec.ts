import { mariadbTestFlavor } from '@ocoda/event-sourcing-testing/unit';
import type { Queryable } from '../../lib/mariadb.schema.js';
import { probeServer } from '../../lib/mariadb.server.js';
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
