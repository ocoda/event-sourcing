import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/main.ts'],
	format: ['cjs'],
	target: 'es2023',
	noExternal: ['@ocoda/event-sourcing'],
	sourcemap: true,
	watch: [
		'./src/**/*',
		'../packages/core/lib/**/*',
	],
});
