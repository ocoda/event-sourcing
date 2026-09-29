/**
 * Shared Vitest configuration for the packages in this monorepo.
 *
 * Plain ESM with no imports so it loads without a TypeScript loader; each package's `vitest.config.mts`
 * merges it with `mergeConfig` and adds its own `resolve.alias` entries.
 *
 * @type {import('vitest/config').ViteUserConfig}
 */
export default {
	// Vite 8 transforms TypeScript with Oxc, which also applies the nearest tsconfig.json (experimentalDecorators,
	// emitDecoratorMetadata, useDefineForClassFields: true), so every package tsconfig must include its tests.
	// The decorator options are repeated here (and take precedence over the tsconfig) so that a file no tsconfig
	// covers still gets legacy decorators with the `design:paramtypes` metadata Nest DI needs, rather than TC39
	// decorators. Class fields keep define semantics, matching the published build.
	// packages/core/tests/unit/decorator-metadata.spec.ts guards this.
	oxc: {
		decorator: {
			legacy: true,
			emitDecoratorMetadata: true,
		},
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
		// Load the Reflect metadata polyfill before any decorated class is evaluated, otherwise the emitted
		// `design:*` metadata is silently dropped.
		setupFiles: ['reflect-metadata'],
		// Restores every `vi.spyOn` spy before each test. `clearMocks` is left at the Vitest 5 default (true).
		restoreMocks: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov', 'json-summary'],
			include: ['lib/**/*.ts'],
			exclude: [
				'lib/**/*.d.ts',
				'lib/**/index.ts',
				'lib/**/*.interface.ts',
				'lib/**/*.type.ts',
				'lib/**/*.enum.ts',
				'lib/**/*.constants.ts',
			],
			thresholds: {
				branches: 80,
				functions: 90,
				lines: 90,
				statements: 90,
			},
		},
	},
};
