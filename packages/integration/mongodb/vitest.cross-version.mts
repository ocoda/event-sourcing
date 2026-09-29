import { configDefaults, defineConfig } from 'vitest/config';

import config from './vitest.config.mts';

// The cross-version specs (tests/cross-version): this driver reads the corpus that the published 3.0.2 packages
// wrote (fixtures/cross-version/v3). scripts/test-cross-version.mjs writes the corpus, then runs them with this
// config and XV_MANIFEST, XV_NAMESPACE and TZ set: `pnpm test:cross-version --database <db>`. They are not part of
// `test` or `test:cov` and don't count towards coverage.
export default defineConfig({
	...config,
	test: {
		...config.test,
		include: ['tests/cross-version/**/*.spec.ts'],
		exclude: configDefaults.exclude,
		coverage: { ...config.test?.coverage, enabled: false },
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
