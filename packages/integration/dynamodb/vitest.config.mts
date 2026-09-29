import { resolve } from 'node:path';

import base from '@ocoda/event-sourcing-config/vitest/base.mjs';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
	base,
	defineConfig({
		resolve: {
			// Run against the TypeScript sources rather than the built dist. A string key also matches its subpaths
			// ('@ocoda/event-sourcing/integration'), but not '@ocoda/event-sourcing-dynamodb'.
			alias: {
				'@ocoda/event-sourcing': resolve(import.meta.dirname, '../../core/lib'),
				'@ocoda/event-sourcing-dynamodb': resolve(import.meta.dirname, 'lib'),
				'@ocoda/event-sourcing-testing': resolve(import.meta.dirname, '../../testing'),
			},
		},
	}),
);
