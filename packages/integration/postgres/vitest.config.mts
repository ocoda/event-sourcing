import { resolve } from 'node:path';

import base from '@ocoda/event-sourcing-config/vitest/base.mjs';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
	base,
	defineConfig({
		resolve: {
			// Run against the TypeScript sources rather than the built dist. A string key also matches its subpaths
			// ('@ocoda/event-sourcing/integration'), but not '@ocoda/event-sourcing-postgres'.
			alias: {
				'@ocoda/event-sourcing': resolve(import.meta.dirname, '../../core/lib'),
				'@ocoda/event-sourcing-postgres': resolve(import.meta.dirname, 'lib'),
				'@ocoda/event-sourcing-testing': resolve(import.meta.dirname, '../../testing'),
			},
		},
		test: {
			// The cross-version specs read a corpus that the published 3.0.2 packages write first:
			// scripts/test-cross-version.mjs runs them with vitest.cross-version.mts.
			exclude: [...configDefaults.exclude, 'tests/cross-version/**'],
		},
	}),
);
