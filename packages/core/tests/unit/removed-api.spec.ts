import * as EventSourcing from '@ocoda/event-sourcing';
import { EventId, EventStore, InMemoryEventStore, ULID } from '@ocoda/event-sourcing';
import * as Conformance from '@ocoda/event-sourcing-testing/conformance';
import { createTestContext } from '@ocoda/event-sourcing-testing/unit';

/**
 * The API that 4.0 removes: the 3.x year-month reads, which `readAll` replaces, and the interim path of the 4.0
 * prereleases for stores that override `appendEvents`. Guards against bringing any of it back.
 */
describe('removed API', () => {
	const store = new InMemoryEventStore(createTestContext(), { driver: InMemoryEventStore });

	it.each([
		// Replaced by readAll({ fromPosition, batch, pool })
		'getAllEnvelopes',
		// The year-month buckets of getAllEnvelopes
		'getYearMonthRange',
		// The event map accessor of stores that serialized themselves; the base class serializes
		'eventMap',
	])('EventStore has no %s, nor has a store', (member) => {
		expect(member in EventStore.prototype).toBe(false);
		expect(member in store).toBe(false);
	});

	it('ULID and EventId have no yearMonth', () => {
		expect('yearMonth' in ULID.prototype).toBe(false);
		expect('yearMonth' in ULID.generate()).toBe(false);
		expect('yearMonth' in EventId.generate()).toBe(false);
	});

	it.each(['getStreamVersion', 'readAll', 'persistEvents'])(
		'EventStore has no default for %s: it is abstract, every store implements it',
		(method) => {
			expect(Object.hasOwn(EventStore.prototype, method)).toBe(false);
		},
	);

	it('exports none of the interim path', () => {
		const removed = /legacy|interim|AllEventsFilter|AppendEventsArguments|YearMonth/i;
		expect(Object.keys(EventSourcing).filter((key) => removed.test(key))).toEqual([]);
		expect(Object.keys(Conformance).filter((key) => removed.test(key))).toEqual([]);
	});

	it('removes the types', () => {
		// @ts-expect-error IAllEventsFilter went with getAllEnvelopes: readAll takes an IReadAllFilter
		expectTypeOf<EventSourcing.IAllEventsFilter>().toBeObject();
		// @ts-expect-error appendEvents has two overloads instead: the options form and the deprecated positional form
		expectTypeOf<EventSourcing.AppendEventsArguments>().toBeArray();
		expectTypeOf<EventStore>().not.toHaveProperty('getAllEnvelopes');
		expectTypeOf<ULID>().not.toHaveProperty('yearMonth');
		expectTypeOf<EventId>().not.toHaveProperty('yearMonth');
	});
});
