import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['lib/in-memory.ts', 'lib/dynamodb.ts', 'lib/mariadb.ts', 'lib/mongodb.ts', 'lib/postgres.ts'],
	format: ['cjs'],
	target: 'es2023',
	noExternal: [
		'@ocoda/event-sourcing',
		'@ocoda/event-sourcing-dynamodb',
		'@ocoda/event-sourcing-mariadb',
		'@ocoda/event-sourcing-mongodb',
		'@ocoda/event-sourcing-postgres',
		'@ocoda/event-sourcing-example',
	],
});
