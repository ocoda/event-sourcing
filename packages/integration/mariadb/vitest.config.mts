import { resolve } from 'node:path';

import base from '@ocoda/event-sourcing-config/vitest/base.mjs';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
	base,
	defineConfig({
		resolve: {
			// Run against the TypeScript sources rather than the built dist. A string key also matches its subpaths
			// ('@ocoda/event-sourcing/integration'), but not '@ocoda/event-sourcing-mariadb'.
			alias: {
				'@ocoda/event-sourcing': resolve(import.meta.dirname, '../../core/lib'),
				'@ocoda/event-sourcing-mariadb': resolve(import.meta.dirname, 'lib'),
				'@ocoda/event-sourcing-testing': resolve(import.meta.dirname, '../../testing'),
			},
		},
		test: {
			// The cross-version specs read a corpus that the published 3.0.2 packages write first:
			// scripts/test-cross-version.mjs runs them with vitest.cross-version.mts.
			exclude: [...configDefaults.exclude, 'tests/cross-version/**'],
			// The migration from 3.x runs on MariaDB only: on MySQL its live specs are skipped, and so is the coverage of
			// its steps and statements (the planner's specs need no database, and run on both)
			...(process.env.ES_TEST_MARIADB_FLAVOR === 'mysql'
				? {
						coverage: {
							exclude: [...(base.test?.coverage?.exclude ?? []), 'lib/migration/migrate.ts', 'lib/migration/sql.ts'],
						},
					}
				: {}),
		},
	}),
);
