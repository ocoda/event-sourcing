/**
 * Connection settings for the database-backed specs, read from the environment.
 *
 * The defaults are the services of the root `docker-compose.yml`, so `docker compose up` plus `pnpm test` needs no
 * configuration. Set the variables to run against other servers, or against a database of your own on a shared
 * server (every spec uses fixed table and collection names, so two runs must not share a database).
 *
 * | Variable | Default |
 * |---|---|
 * | `ES_TEST_PG_HOST`, `ES_TEST_PG_PORT` | `127.0.0.1`, `5432` |
 * | `ES_TEST_PG_USER`, `ES_TEST_PG_PASSWORD`, `ES_TEST_PG_DATABASE` | `postgres` |
 * | `ES_TEST_MARIADB_HOST`, `ES_TEST_MARIADB_PORT` | `127.0.0.1`, `3306` |
 * | `ES_TEST_MARIADB_USER`, `ES_TEST_MARIADB_PASSWORD`, `ES_TEST_MARIADB_DATABASE` | `mariadb` |
 * | `ES_TEST_MARIADB_ROOT_PASSWORD` | `mariadb` |
 * | `ES_TEST_MONGODB_URL` | `mongodb://localhost:27017` (a standalone server) |
 * | `ES_TEST_MONGODB_RS_URL` | unset: no replica-set run (e.g. `mongodb://localhost:27018/?replicaSet=rs0`) |
 *
 * An empty variable counts as unset. In CI (`CI` set) `ES_TEST_MONGODB_RS_URL` is required, so a MongoDB job cannot
 * lose its replica-set run without failing.
 */

/** The connection settings of a SQL database. */
export interface SqlTestConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

/** A MongoDB deployment the MongoDB specs run against. */
export interface MongoDBTestTopology {
	name: 'standalone' | 'replica-set';
	url: string;
}

const env = (name: string, fallback: string): string => process.env[name] || fallback;

const port = (name: string, fallback: number): number => {
	const value = process.env[name];
	if (!value) {
		return fallback;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
		throw new Error(`${name} must be a port number, got '${value}'`);
	}
	return parsed;
};

/** The PostgreSQL connection settings (`ES_TEST_PG_*`). */
export const postgresTestConfig = (): SqlTestConfig => ({
	host: env('ES_TEST_PG_HOST', '127.0.0.1'),
	port: port('ES_TEST_PG_PORT', 5432),
	user: env('ES_TEST_PG_USER', 'postgres'),
	password: env('ES_TEST_PG_PASSWORD', 'postgres'),
	database: env('ES_TEST_PG_DATABASE', 'postgres'),
});

/** The MariaDB connection settings of the unprivileged user (`ES_TEST_MARIADB_*`). */
export const mariadbTestConfig = (): SqlTestConfig => ({
	host: env('ES_TEST_MARIADB_HOST', '127.0.0.1'),
	port: port('ES_TEST_MARIADB_PORT', 3306),
	user: env('ES_TEST_MARIADB_USER', 'mariadb'),
	password: env('ES_TEST_MARIADB_PASSWORD', 'mariadb'),
	database: env('ES_TEST_MARIADB_DATABASE', 'mariadb'),
});

/**
 * The MariaDB connection settings of `root` on the same server and database (`ES_TEST_MARIADB_ROOT_PASSWORD`), for
 * setup that needs privileges the test user lacks.
 */
export const mariadbRootConfig = (): SqlTestConfig => ({
	...mariadbTestConfig(),
	user: 'root',
	password: env('ES_TEST_MARIADB_ROOT_PASSWORD', 'mariadb'),
});

/**
 * The MongoDB deployments to run the MongoDB specs against: always the standalone server (`ES_TEST_MONGODB_URL`),
 * first, and the replica set when `ES_TEST_MONGODB_RS_URL` is set. Locally the replica set is optional; in CI a
 * missing `ES_TEST_MONGODB_RS_URL` throws instead of silently dropping the replica-set run.
 */
export const mongodbTestTopologies = (): MongoDBTestTopology[] => {
	const topologies: MongoDBTestTopology[] = [
		{ name: 'standalone', url: env('ES_TEST_MONGODB_URL', 'mongodb://localhost:27017') },
	];

	const replicaSetUrl = process.env.ES_TEST_MONGODB_RS_URL;
	if (replicaSetUrl) {
		topologies.push({ name: 'replica-set', url: replicaSetUrl });
	} else if (process.env.CI && process.env.CI !== 'false') {
		throw new Error(
			'ES_TEST_MONGODB_RS_URL must be set in CI: the MongoDB specs run on the standalone server and on a replica set',
		);
	}

	return topologies;
};
