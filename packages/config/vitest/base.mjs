import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		swc.vite({
			jsc: {
				parser: { syntax: 'typescript', decorators: true },
				transform: { legacyDecorator: true, decoratorMetadata: true },
				target: 'es2016',
				keepClassNames: true,
			},
			module: { type: 'es6' },
		}),
	],
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
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
				lines: 90,
				functions: 90,
				branches: 80,
				statements: 90,
			},
		},
	},
});
