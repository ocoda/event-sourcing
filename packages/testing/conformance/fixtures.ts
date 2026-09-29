import { randomUUID } from 'node:crypto';
import {
	Aggregate,
	AggregateRoot,
	DefaultEventSerializer,
	Event,
	EventMap,
	EventStream,
	type IEvent,
	type ISnapshot,
	SnapshotStream,
	UUID,
	isEventSourcingError,
} from '@ocoda/event-sourcing';

export class ConformanceId extends UUID {}

/**
 * The aggregate whose streams the conformance suites write to.
 */
@Aggregate({ streamName: 'conformance-ledger' })
export class ConformanceLedger extends AggregateRoot {
	public state: unknown;
}

/**
 * A second aggregate, used to check that per-aggregate reads leave other aggregates alone.
 */
@Aggregate({ streamName: 'conformance-audit' })
export class ConformanceAudit extends AggregateRoot {
	public state: unknown;
}

export type ConformanceSnapshot = ISnapshot<ConformanceLedger>;

@Event('conformance-recorded')
export class ConformanceRecorded implements IEvent {
	constructor(
		public readonly seq: number,
		public readonly writer: string = 'conformance',
	) {}
}

@Event('conformance-payload-probed')
export class ConformancePayloadProbed implements IEvent {
	constructor(public readonly data: Record<string, unknown>) {}
}

/**
 * The name of an event that is stored but never registered in the event map, so it can't be deserialized.
 */
export const UNREGISTERED_EVENT_NAME = 'conformance-unregistered';

export const createConformanceEventMap = (): EventMap => {
	const eventMap = new EventMap();
	eventMap.register(ConformanceRecorded, DefaultEventSerializer.for(ConformanceRecorded));
	eventMap.register(ConformancePayloadProbed, DefaultEventSerializer.for(ConformancePayloadProbed));
	return eventMap;
};

export const newEventStream = (): EventStream => EventStream.for(ConformanceLedger, ConformanceId.generate());

export const newSnapshotStream = (
	aggregate: typeof ConformanceLedger | typeof ConformanceAudit = ConformanceLedger,
): SnapshotStream => SnapshotStream.for(aggregate, ConformanceId.generate());

/**
 * `count` events numbered `from`, `from + 1`, ...
 */
export const recordedEvents = (count: number, from = 1, writer?: string): ConformanceRecorded[] =>
	Array.from({ length: count }, (_, index) => new ConformanceRecorded(from + index, writer));

/**
 * A payload of JSON-safe values that every store has to return exactly as it was written.
 */
export const createJsonPayloadProbe = (): Record<string, unknown> => ({
	unicode: 'Zoë · 東京 · Ελληνικά · עברית · नमस्ते · 🚀👩🏽‍💻',
	quotes: `She said "it's fine" and left a \`backtick\``,
	apostrophes: "O'Brien's l'été ''doubled''",
	sqlLike: "'); DROP TABLE events; --",
	escapes: 'back\\slash / "quoted" \\"escaped\\"\nnew line\ttab',
	jsonLike: '{"not":"parsed","array":[1,2]}',
	emptyString: '',
	nestedArrays: [[1, 2], [3, [4, [5, [6]]]], [], [{ deep: [{ deeper: ['x', 'y'] }] }]],
	mixedArray: [1, 'two', true, null, { three: 3 }, [4]],
	objects: { a: { b: { c: { d: 'e' } } }, emptyObject: {}, emptyArray: [] },
	numbers: {
		maxSafeInteger: Number.MAX_SAFE_INTEGER,
		minSafeInteger: Number.MIN_SAFE_INTEGER,
		aboveInt32: 2 ** 31,
		aboveUint32: 2 ** 32 + 1,
		nearMaxSafe: 2 ** 52 + 3,
		zero: 0,
		negative: -42,
		decimal: 1234.5678,
		fraction: 0.1,
		negativeDecimal: -273.15,
	},
	booleans: [true, false],
	nothing: null,
});

/**
 * Dates in a payload, and the ISO-8601 strings the stores return for them (what `JSON.stringify()` produces).
 */
export const createDatePayloadProbe = () => {
	const dates = {
		leapDay: new Date('2024-02-29T23:59:59.999Z'),
		epoch: new Date(0),
		recent: new Date('2025-07-14T08:15:30.042Z'),
	};

	return {
		payload: { at: dates.leapDay, list: [dates.epoch, dates.recent], nested: { at: dates.recent } },
		expected: {
			at: dates.leapDay.toISOString(),
			list: [dates.epoch.toISOString(), dates.recent.toISOString()],
			nested: { at: dates.recent.toISOString() },
		},
	};
};

/**
 * A pool name that no other test run uses, so parallel runs and leftovers of earlier runs can't skew the results.
 * Kept short and lowercase: it ends up in table names, which some databases limit in length or compare case-sensitively.
 */
export const uniquePoolName = (prefix = 'conformance'): string => `${prefix}-${randomUUID().slice(0, 8)}`;

/**
 * More reads than the default connection pools of the drivers hold (pg: 10, mariadb: 10). A read that doesn't give
 * its connection back when the consumer stops early exhausts the pool, and the follow-up call then times out.
 */
export const LEAK_PROBE_ITERATIONS = 12;

/**
 * How long a single store call may take before it is considered hanging.
 */
export const CALL_TIMEOUT = 10_000;

/**
 * The default timeout of every conformance test.
 */
export const TEST_TIMEOUT = 30_000;

/**
 * The timeout of the heaviest concurrency cases (`read-all-gap-safe`, `concurrent-any`).
 */
export const HEAVY_TEST_TIMEOUT = 60_000;

/**
 * Rejects when the promise doesn't settle in time, so a hanging store fails the test with a clear message
 * instead of running into the test timeout.
 */
export const withinTimeout = <T>(promise: Promise<T>, description: string, milliseconds = CALL_TIMEOUT): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${description} did not settle within ${milliseconds}ms (is the store hanging?)`)),
				milliseconds,
			);
		}),
	]).finally(() => clearTimeout(timer));
};

/**
 * Calls a store method that may be synchronous. A synchronous throw becomes a rejection.
 */
export const call = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn);

/**
 * Reads every batch of a generator. The batches are kept as they were handed out.
 */
export const collectBatches = async <T>(generator: AsyncGenerator<T[]>): Promise<T[][]> => {
	const batches: T[][] = [];
	for await (const batch of generator) {
		batches.push(batch);
	}
	return batches;
};

/**
 * Reads every item of a generator.
 */
export const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> =>
	(await collectBatches(generator)).flat();

/**
 * Settles the promise and returns the error it rejected with, or undefined when it resolved.
 */
export const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);

/**
 * Asserts that the promise rejects with the library error of the given class (not a wrapper), and optionally with the
 * given fields. Match errors on their fields and `code`, not on their messages.
 *
 * It checks the brand and the literal `name` rather than the constructor, so a store that resolves another copy of
 * `@ocoda/event-sourcing` passes too.
 */
export const expectRejectionOfClass = async (
	promise: Promise<unknown>,
	exception: abstract new (...args: never[]) => Error,
	fields?: Record<string, unknown>,
): Promise<void> => {
	const error = await rejectionOf(promise);

	expect(isEventSourcingError(error), `expected a rejection with ${exception.name}, got ${String(error)}`).toBe(true);
	expect((error as Error).name).toBe(exception.name);
	if (fields) {
		expect(error).toMatchObject(fields);
	}
};

/**
 * Asserts that the promise rejects, with any error.
 */
export const expectRejection = async (promise: Promise<unknown>, description: string): Promise<void> => {
	const error = await rejectionOf(promise);
	expect(error, `expected ${description} to reject`).toBeDefined();
};

/**
 * `JSON.stringify` for assertion messages: bigints (global positions) are written as `123n` instead of making it throw.
 */
export const stringify = (value: unknown): string => {
	const json = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item));
	return json === undefined ? String(value) : json;
};

/**
 * How often every conformance case runs: `CONFORMANCE_REPEAT=n` runs each case n times, to soak out flaky
 * concurrency. Defaults to once.
 */
export const conformanceRepeat = (value = process.env.CONFORMANCE_REPEAT): number => {
	const repeat = Number(value);
	return Number.isSafeInteger(repeat) && repeat > 1 ? repeat : 1;
};

/**
 * The options of a single conformance case.
 */
export interface ConformanceTestOptions<TCapabilities> {
	/**
	 * The timeout of the case, in milliseconds.
	 */
	timeout?: number;
	/**
	 * Gates the case on the capabilities of the store: returns the capability the store lacks (the case is then skipped
	 * with `capability: <what it returned>`), or undefined to run the case. It is evaluated when the case runs, once
	 * the store is connected, because a store's capabilities are only final then.
	 */
	requires?: (capabilities: TCapabilities) => string | undefined;
}

/**
 * Options of a whole conformance suite that shape how its cases are registered.
 */
export interface ConformanceSuiteOptions<TCase extends string> {
	/**
	 * Registers only these cases.
	 */
	only?: readonly TCase[];
	/**
	 * Registers every case as a test that must fail (`it.fails`): for negative controls, deliberately broken stores that
	 * prove a case detects what it checks.
	 */
	expectFailure?: boolean;
}

/**
 * Whether the case is skipped: it has a reason in `skip`, and `CONFORMANCE_RUN_SKIPPED` isn't `true`.
 */
export const isSkippedCase = <TCase extends string>(skip: Partial<Record<TCase, string>> | undefined, id: TCase) =>
	Boolean(skip?.[id]) && process.env.CONFORMANCE_RUN_SKIPPED !== 'true';

/**
 * Registers a conformance test, or skips it with the reason the store gave for not satisfying it (yet).
 * Set `CONFORMANCE_RUN_SKIPPED=true` to run the skipped cases anyway, e.g. to check whether a skip is still needed.
 *
 * `capabilities` returns the capabilities of the connected store, for the cases gated with `requires`. Unlike a skip,
 * a capability gate is not a gap, so `CONFORMANCE_RUN_SKIPPED` doesn't lift it. `CONFORMANCE_REPEAT=n` runs every
 * case n times.
 */
export const conformanceTest = <TCase extends string, TCapabilities = never>(
	skip: Partial<Record<TCase, string>> | undefined,
	timeout: number,
	capabilities?: () => TCapabilities,
	{ only, expectFailure = false }: ConformanceSuiteOptions<TCase> = {},
) => {
	const runSkipped = process.env.CONFORMANCE_RUN_SKIPPED === 'true';
	const repeats = conformanceRepeat() - 1;
	const register = expectFailure ? it.fails : it;

	return (
		id: TCase,
		title: string,
		fn: () => Promise<void>,
		options: number | ConformanceTestOptions<TCapabilities> = {},
	): void => {
		if (only && !only.includes(id)) {
			return;
		}
		const { timeout: testTimeout = timeout, requires } = typeof options === 'number' ? { timeout: options } : options;
		const reason = skip?.[id];
		if (reason && !runSkipped) {
			it.skip(`${title} [${id}] (skipped: ${reason})`, fn);
			return;
		}
		if (requires && !capabilities) {
			throw new Error(`The conformance case ${id} requires a capability, but the suite has no capabilities to check`);
		}
		register(`${title} [${id}]`, { timeout: testTimeout, repeats }, async (context) => {
			const missing = requires?.((capabilities as () => TCapabilities)());
			if (missing) {
				context.skip(`capability: ${missing}`);
			}
			await fn();
		});
	};
};
