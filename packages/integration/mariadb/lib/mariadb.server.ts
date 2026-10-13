import type { Queryable } from './mariadb.schema.js';

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
