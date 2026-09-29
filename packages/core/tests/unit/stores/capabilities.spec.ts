import {
	DEFAULT_EVENT_STORE_CAPABILITIES,
	type EventStoreCapabilities,
	resolveCapabilities,
} from '@ocoda/event-sourcing';

describe(resolveCapabilities, () => {
	it('pins the defaults', () => {
		expect(DEFAULT_EVENT_STORE_CAPABILITIES).toEqual({
			atomicAppend: true,
			headers: false,
			globalOrder: 'best-effort',
		});
		expect(Object.isFrozen(DEFAULT_EVENT_STORE_CAPABILITIES)).toBe(true);
	});

	it('fills every flag a store leaves out with its default', () => {
		expect(resolveCapabilities()).toEqual(DEFAULT_EVENT_STORE_CAPABILITIES);
		expect(resolveCapabilities(null)).toEqual(DEFAULT_EVENT_STORE_CAPABILITIES);
		expect(resolveCapabilities({})).toEqual(DEFAULT_EVENT_STORE_CAPABILITIES);
		expect(resolveCapabilities({ headers: true })).toEqual({
			atomicAppend: true,
			headers: true,
			globalOrder: 'best-effort',
		});
	});

	it('keeps every flag a store declares', () => {
		const declared = { atomicAppend: false, headers: true, globalOrder: 'gap-safe' } as const;

		expect(resolveCapabilities(declared)).toEqual(declared);
	});

	it('treats a flag set to undefined or to a value of the wrong type as left out', () => {
		expect(
			resolveCapabilities({
				atomicAppend: undefined,
				headers: 'yes',
				globalOrder: 'gapless',
			} as unknown as EventStoreCapabilities),
		).toEqual(DEFAULT_EVENT_STORE_CAPABILITIES);
	});

	it('returns a new object, so reading the capabilities never changes them', () => {
		const declared: EventStoreCapabilities = { headers: true };
		const resolved = resolveCapabilities(declared);
		resolved.atomicAppend = false;

		expect(declared).toEqual({ headers: true });
		expect(resolveCapabilities()).not.toBe(resolveCapabilities());
		expectTypeOf(resolved).toEqualTypeOf<Required<EventStoreCapabilities>>();
	});
});
