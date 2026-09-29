import type { EventStoreCapabilities } from '@ocoda/event-sourcing';
import {
	conformanceRepeat,
	conformanceTest,
	isSkippedCase,
	stringify,
} from '@ocoda/event-sourcing-testing/conformance';
import type { RunnerTestCase } from 'vitest';

// The harness of the conformance suites (packages/testing/conformance/fixtures.ts), which every store's conformance
// spec runs through.

/**
 * The result of a sibling test that ran before the current one. `note` is the reason passed to `context.skip()`.
 * The tests that read it rely on their siblings running first, so they fail when run on their own (`vitest -t`).
 */
const resultOf = (task: RunnerTestCase, id: string) => {
	const sibling = task.suite?.tasks.find(({ name }) => name.includes(`[${id}]`));
	return sibling?.result as { state: string; note?: string; repeatCount?: number } | undefined;
};

/**
 * Runs `fn` with the given environment variables set (`undefined` unsets one), then restores them. The harness reads
 * `CONFORMANCE_RUN_SKIPPED` and `CONFORMANCE_REPEAT` when a suite is built, so the suites below are built under a fixed
 * environment, whatever the environment of the test run.
 */
const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
	const set = (values: Record<string, string | undefined>) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	set(env);
	try {
		return fn();
	} finally {
		set(previous);
	}
};

const HARNESS_ENV = ['CONFORMANCE_RUN_SKIPPED', 'CONFORMANCE_REPEAT'] as const;

/**
 * Builds a suite under the given harness environment; the harness variables it doesn't name are unset.
 */
const withHarnessEnv = <T>(env: Partial<Record<(typeof HARNESS_ENV)[number], string>>, fn: () => T): T =>
	withEnv({ ...Object.fromEntries(HARNESS_ENV.map((key) => [key, undefined])), ...env }, fn);

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

	it('reads the environment by default', () => {
		expect(withEnv({ CONFORMANCE_REPEAT: undefined }, () => conformanceRepeat())).toBe(1);
		expect(withEnv({ CONFORMANCE_REPEAT: '4' }, () => conformanceRepeat())).toBe(4);
	});
});

describe(conformanceTest, () => {
	type GatedCase = 'needs-headers' | 'needs-gap-safe' | 'ungated' | 'documented-gap';
	const capabilities: Required<EventStoreCapabilities> = {
		atomicAppend: true,
		headers: true,
		globalOrder: 'best-effort',
	};
	/**
	 * Registers the four gated cases, which record in `ran` that they ran.
	 */
	const registerGatedCases = (ran: GatedCase[]) => {
		const test = conformanceTest<GatedCase, Required<EventStoreCapabilities>>(
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
	};

	describe('capability gates', () => {
		const ran: GatedCase[] = [];
		withHarnessEnv({}, () => registerGatedCases(ran));

		it('runs only the cases the store qualifies for, and reports the lacking capability', ({ task }) => {
			expect(ran).toEqual(['needs-headers', 'ungated']);
			expect(resultOf(task, 'needs-headers')?.state).toBe('pass');
			expect(resultOf(task, 'needs-gap-safe')).toMatchObject({
				state: 'skip',
				note: "capability: globalOrder 'gap-safe'",
			});
		});
	});

	describe('capability gates with CONFORMANCE_RUN_SKIPPED=true', () => {
		const ran: GatedCase[] = [];
		withHarnessEnv({ CONFORMANCE_RUN_SKIPPED: 'true' }, () => registerGatedCases(ran));

		it('runs the skipped cases, but not the cases the store lacks the capability for', ({ task }) => {
			expect(ran).toEqual(['needs-headers', 'ungated', 'documented-gap']);
			expect(resultOf(task, 'documented-gap')?.state).toBe('pass');
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
		const test = withHarnessEnv({ CONFORMANCE_REPEAT: '3' }, () => conformanceTest<'repeated'>(undefined, 5_000));

		test('repeated', 'runs every case n times', async () => {
			runs++;
		});

		it('ran the case three times', ({ task }) => {
			expect(runs).toBe(3);
			expect(resultOf(task, 'repeated')).toMatchObject({ state: 'pass', repeatCount: 2 });
		});
	});

	describe('only', () => {
		const ran: string[] = [];
		const test = withHarnessEnv({}, () =>
			conformanceTest<'kept' | 'left-out'>(undefined, 5_000, undefined, { only: ['kept'] }),
		);

		test('kept', 'registers a listed case', async () => {
			ran.push('kept');
		});
		test('left-out', 'does not register a case that is not listed', async () => {
			ran.push('left-out');
		});

		it('registered only the listed case', ({ task }) => {
			expect(ran).toEqual(['kept']);
			expect(resultOf(task, 'left-out')).toBeUndefined();
		});
	});

	describe('expectFailure', () => {
		const test = withHarnessEnv({}, () =>
			conformanceTest<'broken'>(undefined, 5_000, undefined, { expectFailure: true }),
		);

		test('broken', 'registers a case that must fail', async () => {
			throw new Error('the detector fired');
		});

		it('passes because the case failed', ({ task }) => {
			expect(resultOf(task, 'broken')?.state).toBe('pass');
		});
	});

	describe(isSkippedCase, () => {
		it('is true for a case with a reason, unless CONFORMANCE_RUN_SKIPPED is true', () => {
			const skip = { gap: 'a documented gap' };

			expect(withHarnessEnv({}, () => isSkippedCase(skip, 'gap'))).toBe(true);
			expect(withHarnessEnv({}, () => isSkippedCase<string>(skip, 'other'))).toBe(false);
			expect(withHarnessEnv({}, () => isSkippedCase(undefined, 'gap'))).toBe(false);
			expect(withHarnessEnv({ CONFORMANCE_RUN_SKIPPED: 'true' }, () => isSkippedCase(skip, 'gap'))).toBe(false);
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
