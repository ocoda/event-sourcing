import type { EventStoreCapabilities } from '@ocoda/event-sourcing';
import { conformanceRepeat, conformanceTest, stringify } from '@ocoda/event-sourcing-testing/conformance';
import type { RunnerTestCase } from 'vitest';

// The harness of the conformance suites (packages/testing/conformance/fixtures.ts), which every store's conformance
// spec runs through.

/**
 * The result of a sibling test that ran before the current one. `note` is the reason passed to `context.skip()`.
 */
const resultOf = (task: RunnerTestCase, id: string) => {
	const sibling = task.suite?.tasks.find(({ name }) => name.includes(`[${id}]`));
	return sibling?.result as { state: string; note?: string; repeatCount?: number } | undefined;
};

describe(stringify, () => {
	it('writes bigints, such as global positions, instead of throwing', () => {
		const filter = { fromPosition: 9007199254740993n, batch: 2, pool: 'tenant' };

		expect(() => JSON.stringify(filter)).toThrow(TypeError);
		expect(stringify(filter)).toBe('{"fromPosition":"9007199254740993n","batch":2,"pool":"tenant"}');
		expect(stringify([1n, { nested: -2n }])).toBe('["1n",{"nested":"-2n"}]');
	});

	it('writes everything else like JSON.stringify', () => {
		const value = { fromVersion: 3, direction: 1, at: new Date(0), skipped: undefined };

		expect(stringify(value)).toBe(JSON.stringify(value));
		expect(stringify({})).toBe('{}');
	});

	it('describes values that have no JSON', () => {
		expect(stringify(undefined)).toBe('undefined');
		expect(stringify(() => 1)).toContain('=>');
	});
});

describe(conformanceRepeat, () => {
	it.each([
		[undefined, 1],
		['', 1],
		['1', 1],
		['0', 1],
		['-3', 1],
		['2.5', 1],
		['many', 1],
		['2', 2],
		['50', 50],
	])('reads CONFORMANCE_REPEAT=%o as %i run(s)', (value, runs) => {
		expect(conformanceRepeat(value)).toBe(runs);
	});
});

describe(conformanceTest, () => {
	describe('capability gates', () => {
		type Case = 'needs-headers' | 'needs-gap-safe' | 'ungated' | 'documented-gap';
		const capabilities: Required<EventStoreCapabilities> = {
			atomicAppend: true,
			headers: true,
			globalOrder: 'best-effort',
		};
		const ran: Case[] = [];
		const test = conformanceTest<Case, Required<EventStoreCapabilities>>(
			{ 'documented-gap': 'a gap the store documents' },
			5_000,
			() => capabilities,
		);

		test(
			'needs-headers',
			'runs a case whose capability the store claims',
			async () => {
				ran.push('needs-headers');
			},
			{ requires: (caps) => (caps.headers ? undefined : 'headers') },
		);
		test(
			'needs-gap-safe',
			'skips a case whose capability the store lacks',
			async () => {
				ran.push('needs-gap-safe');
			},
			{ requires: (caps) => (caps.globalOrder === 'gap-safe' ? undefined : "globalOrder 'gap-safe'") },
		);
		test('ungated', 'runs a case without a gate', async () => {
			ran.push('ungated');
		});
		test('documented-gap', 'skips a case with a reason', async () => {
			ran.push('documented-gap');
		});

		it('runs only the cases the store qualifies for, and reports the lacking capability', ({ task }) => {
			expect(ran).toEqual(['needs-headers', 'ungated']);
			expect(resultOf(task, 'needs-headers')?.state).toBe('pass');
			expect(resultOf(task, 'needs-gap-safe')).toMatchObject({
				state: 'skip',
				note: "capability: globalOrder 'gap-safe'",
			});
		});
	});

	describe('capability gates without capabilities', () => {
		it('refuses a gated case in a suite that has no capabilities to check', () => {
			const test = conformanceTest<'gated'>(undefined, 5_000);

			expect(() => test('gated', 'never registered', async () => undefined, { requires: () => undefined })).toThrow(
				'The conformance case gated requires a capability, but the suite has no capabilities to check',
			);
		});
	});

	describe('CONFORMANCE_REPEAT', () => {
		let runs = 0;
		const previous = process.env.CONFORMANCE_REPEAT;
		process.env.CONFORMANCE_REPEAT = '3';
		const test = conformanceTest<'repeated'>(undefined, 5_000);
		if (previous === undefined) {
			delete process.env.CONFORMANCE_REPEAT;
		} else {
			process.env.CONFORMANCE_REPEAT = previous;
		}

		test('repeated', 'runs every case n times', async () => {
			runs++;
		});

		it('ran the case three times', ({ task }) => {
			expect(runs).toBe(3);
			expect(resultOf(task, 'repeated')).toMatchObject({ state: 'pass', repeatCount: 2 });
		});
	});

	describe('timeouts', () => {
		it('still takes a timeout as the fourth argument', () => {
			const registered: unknown[][] = [];
			const globals = globalThis as unknown as { it: (...args: unknown[]) => void };
			const register = vi.spyOn(globals, 'it').mockImplementation((...args: unknown[]) => {
				registered.push(args);
			});
			const test = conformanceTest<'timed'>(undefined, 5_000);

			test('timed', 'with a number', async () => undefined, 1_234);
			test('timed', 'with options', async () => undefined, { timeout: 4_321 });
			test('timed', 'with the default', async () => undefined);
			register.mockRestore();

			expect(registered.map(([, options]) => (options as { timeout: number }).timeout)).toEqual([1_234, 4_321, 5_000]);
		});
	});
});
