import base from '@ocoda/event-sourcing-config/vitest/base.mjs';
import { defineConfig, mergeConfig } from 'vitest/config';

// No aliases: the application imports the built packages from node_modules, as it does when it runs (turbo builds
// them first). The spec boots it against PostgreSQL.
export default mergeConfig(
	base,
	defineConfig({
		test: {
			hookTimeout: 60_000,
			testTimeout: 30_000,
		},
	}),
);
