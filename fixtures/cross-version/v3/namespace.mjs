// Connection settings and namespaces of the cross-version fixture.
//
// Every run writes into a namespace of its own, so the default pools ('events', 'snapshots') are safe to use: a
// PostgreSQL schema (created as the test user, reached through search_path), a MariaDB database (created as root and
// granted to the test user) or a MongoDB database (named in the URL, created on the first write).
//
// The settings come from the ES_TEST_* variables of packages/testing/unit/db.ts, with the same defaults (the services
// of docker-compose.yml). This file is plain JavaScript outside the pnpm workspace, so it repeats them.
//
// CLI (used by scripts/test-cross-version.mjs):
//   node namespace.mjs create|drop --database <postgres|mariadb|mongodb> --namespace xv_<run> [--url <mongodb url>]
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createConnection } from 'mariadb';
import { MongoClient } from 'mongodb';
import pg from 'pg';

export const DATABASES = ['postgres', 'mariadb', 'mongodb'];

const NAMESPACE_PATTERN = /^xv_[a-z0-9_]{1,40}$/;

const env = (name, fallback) => process.env[name] || fallback;
const port = (name, fallback) => {
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

export const postgresSettings = () => ({
	host: env('ES_TEST_PG_HOST', '127.0.0.1'),
	port: port('ES_TEST_PG_PORT', 5432),
	user: env('ES_TEST_PG_USER', 'postgres'),
	password: env('ES_TEST_PG_PASSWORD', 'postgres'),
	database: env('ES_TEST_PG_DATABASE', 'postgres'),
});

export const mariadbSettings = () => ({
	host: env('ES_TEST_MARIADB_HOST', '127.0.0.1'),
	port: port('ES_TEST_MARIADB_PORT', 3306),
	user: env('ES_TEST_MARIADB_USER', 'mariadb'),
	password: env('ES_TEST_MARIADB_PASSWORD', 'mariadb'),
});

const mariadbRootSettings = () => ({
	...mariadbSettings(),
	user: 'root',
	password: env('ES_TEST_MARIADB_ROOT_PASSWORD', 'mariadb'),
});

/** Accepts 'pg' as an alias of 'postgres'. */
export const parseDatabase = (value) => {
	const database = value === 'pg' ? 'postgres' : value;
	if (!DATABASES.includes(database)) {
		throw new Error(`--database must be one of ${DATABASES.join(', ')}, got '${value}'`);
	}
	return database;
};

export const parseNamespace = (value) => {
	if (!NAMESPACE_PATTERN.test(value ?? '')) {
		throw new Error(`--namespace must match ${NAMESPACE_PATTERN}, got '${value}'`);
	}
	return value;
};

/** The options of a 3.x event or snapshot store (without its driver) that write into the namespace. */
export const storeOptions = ({ database, namespace, url }) => {
	switch (database) {
		case 'postgres':
			return { ...postgresSettings(), options: `-c search_path=${namespace}` };
		case 'mariadb':
			return { ...mariadbSettings(), database: namespace };
		case 'mongodb':
			if (!url) {
				throw new Error('--url is required for mongodb (the URL names the namespace as its database)');
			}
			return { url };
	}
};

/** Opens a raw client on the namespace, for the edits 3.x can't make through its public API. */
export const openClient = async (target) => {
	const options = storeOptions(target);
	switch (target.database) {
		case 'postgres': {
			const client = new pg.Client(options);
			await client.connect();
			return {
				query: async (sql, params) => (await client.query(sql, params)).rows,
				close: () => client.end(),
			};
		}
		case 'mariadb': {
			const connection = await createConnection(options);
			return {
				query: (sql, params) => connection.query(sql, params),
				close: () => connection.end(),
			};
		}
		case 'mongodb': {
			const client = await new MongoClient(options.url).connect();
			return { db: client.db(), close: () => client.close() };
		}
	}
};

export const createNamespace = async ({ database, namespace, url }) => {
	switch (database) {
		case 'postgres': {
			const client = new pg.Client(postgresSettings());
			await client.connect();
			try {
				await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(namespace)}`);
			} finally {
				await client.end();
			}
			return;
		}
		case 'mariadb': {
			const connection = await createConnection(mariadbRootSettings());
			try {
				await connection.query(`CREATE DATABASE \`${namespace}\``);
				const { user } = mariadbSettings();
				if (user !== 'root') {
					await connection.query(`GRANT ALL ON \`${namespace}\`.* TO ${connection.escape(user)}@'%'`);
				}
			} finally {
				await connection.end();
			}
			return;
		}
		case 'mongodb': {
			// Created on the first write. Refuse a namespace that already holds collections.
			const client = await new MongoClient(url).connect();
			try {
				const collections = await client.db().listCollections({}, { nameOnly: true }).toArray();
				if (collections.length > 0) {
					throw new Error(`The MongoDB database ${client.db().databaseName} already exists`);
				}
			} finally {
				await client.close();
			}
			return;
		}
	}
};

export const dropNamespace = async ({ database, namespace, url }) => {
	switch (database) {
		case 'postgres': {
			const client = new pg.Client(postgresSettings());
			await client.connect();
			try {
				await client.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(namespace)} CASCADE`);
			} finally {
				await client.end();
			}
			return;
		}
		case 'mariadb': {
			const connection = await createConnection(mariadbRootSettings());
			try {
				await connection.query(`DROP DATABASE IF EXISTS \`${namespace}\``);
			} finally {
				await connection.end();
			}
			return;
		}
		case 'mongodb': {
			const client = await new MongoClient(url).connect();
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
			}
			return;
		}
	}
};

/** Whether this module is the entry point of the process (`node namespace.mjs …`). */
export const isMain = (meta) =>
	Boolean(process.argv[1]) && meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain(import.meta)) {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: { database: { type: 'string' }, namespace: { type: 'string' }, url: { type: 'string' } },
	});
	const target = {
		database: parseDatabase(values.database),
		namespace: parseNamespace(values.namespace),
		url: values.url,
	};
	const actions = { create: createNamespace, drop: dropNamespace };
	const action = actions[positionals[0]];
	if (!action) {
		throw new Error(`Usage: node namespace.mjs create|drop --database <db> --namespace xv_<run> [--url <url>]`);
	}
	await action(target);
}
