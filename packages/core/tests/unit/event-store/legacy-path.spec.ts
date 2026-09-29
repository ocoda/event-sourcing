import { Logger } from '@nestjs/common';
import {
	type AppendEventsArguments,
	EventEnvelope,
	type EventMap,
	EventStore,
	type EventStream,
	ExpectedVersion,
	type IEvent,
	type IEventCollection,
	type IEventPool,
	InMemoryEventStore,
	InvalidAppendOptionsException,
	InvalidEventEnvelopeException,
	InvalidEventMetadataException,
	UnsupportedOperationException,
} from '@ocoda/event-sourcing';
import { createTestContext, eventStreamAccountA, getEventMap, getEvents } from '@ocoda/event-sourcing-testing/unit';
import type { Mock, MockInstance } from 'vitest';
import { resetPositionalAppendWarning } from '../../../lib/stores/append-arguments.js';
import { isLegacyEventStore } from '../../../lib/stores/legacy-event-store.js';

// INTERIM(H): the path of stores that still override appendEvents the 3.x way, like the database stores until schema v2.

/**
 * A store in the 3.x shape: it overrides appendEvents, serializes with the deprecated eventMap accessor, and has no
 * driver methods.
 */
class LegacyEventStore extends EventStore<{ label: string }> {
	readonly appended: { self: unknown; args: unknown[] }[] = [];

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		return pool ? `${pool}-events` : 'events';
	}
	async *listCollections(): AsyncGenerator<IEventCollection[]> {}
	async getEnvelope(): Promise<EventEnvelope> {
		throw new Error('not implemented');
	}
	async *getEnvelopes(): AsyncGenerator<EventEnvelope[]> {}

	async appendEvents(
		stream: EventStream,
		aggregateVersion: number,
		events: IEvent[] | EventEnvelope[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		this.appended.push({ self: this, args: [stream, aggregateVersion, events, pool] });
		let version = aggregateVersion - events.length + 1;
		return events.map((event) =>
			event instanceof EventEnvelope
				? event
				: EventEnvelope.create(this.eventMap.getName(event), this.eventMap.serializeEvent(event), {
						aggregateId: stream.aggregateId,
						version: version++,
					}),
		);
	}

	/** Exposes the deprecated accessor, which 3.x stores use as `this.eventMap`. */
	eventMapOfContext(): EventMap {
		return this.eventMap;
	}
}

describe('the interim path of stores that override appendEvents', () => {
	const events = getEvents();
	let publish: Mock<(envelope: EventEnvelope) => Promise<undefined>>;
	let store: LegacyEventStore;
	let loggerError: MockInstance;
	// Calls through the type of the base class, which has both forms of appendEvents; the store's own type has the 3.x form
	const base = () => store as EventStore<unknown>;

	beforeEach(() => {
		loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		resetPositionalAppendWarning();
		publish = vi.fn(async () => undefined);
		store = new LegacyEventStore(createTestContext(getEventMap(), publish), { label: 'legacy' });
	});

	afterEach(() => resetPositionalAppendWarning());

	it('wraps the store, and only such a store', () => {
		expect(isLegacyEventStore(store)).toBe(true);
		expect(store).toBeInstanceOf(LegacyEventStore);
		expect(store.eventMapOfContext()).toBeDefined();
		expect(store['options']).toEqual({ label: 'legacy' });
	});

	it("passes the positional form to the store's appendEvents, and publishes what it returns", async () => {
		const envelopes = await base().appendEvents(eventStreamAccountA, 3, events.slice(0, 3), 'tenant');

		expect(store.appended).toEqual([{ self: store, args: [eventStreamAccountA, 3, events.slice(0, 3), 'tenant'] }]);
		expect(envelopes.map(({ metadata }) => metadata.version)).toEqual([1, 2, 3]);
		expect(publish.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
		expect(process.emitWarning).toHaveBeenCalledTimes(1);
	});

	it('keeps the 3.x behaviour of the positional form for what the store checks itself', async () => {
		// The store gets the empty append, as in 3.x
		await expect(base().appendEvents(eventStreamAccountA, 2, [])).resolves.toEqual([]);
		expect(store.appended).toHaveLength(1);
	});

	it('checks the arguments of the positional form', async () => {
		await expect(base().appendEvents(eventStreamAccountA, 1, events.slice(0, 2))).rejects.toBeInstanceOf(
			InvalidAppendOptionsException,
		);
		expect(store.appended).toEqual([]);
	});

	it('passes the options form on in the positional form', async () => {
		const envelopes = await base().appendEvents(eventStreamAccountA, events.slice(0, 2), {
			expectedVersion: 3,
			pool: 'tenant',
		});

		expect(store.appended[0].args).toEqual([eventStreamAccountA, 5, events.slice(0, 2), 'tenant']);
		expect(envelopes.map(({ metadata }) => metadata.version)).toEqual([4, 5]);
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it('publishes nothing for the options form with publish: false, and nothing for an empty append', async () => {
		await base().appendEvents(eventStreamAccountA, events.slice(0, 1), { expectedVersion: 0, publish: false });
		await expect(base().appendEvents(eventStreamAccountA, [], { expectedVersion: 5 })).resolves.toEqual([]);

		expect(store.appended).toHaveLength(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it.each<[string, unknown, abstract new (...args: never[]) => Error, Record<string, unknown>?]>([
		['ExpectedVersion.Any', { expectedVersion: ExpectedVersion.Any }, UnsupportedOperationException],
		['a correlation id', { expectedVersion: 0, metadata: { correlationId: 'c' } }, UnsupportedOperationException],
		['a causation id', { expectedVersion: 0, metadata: { causationId: 'c' } }, UnsupportedOperationException],
		[
			'headers',
			{ expectedVersion: 0, metadata: { headers: { a: 'b' } } },
			UnsupportedOperationException,
			{ operation: 'headers' },
		],
		['invalid headers', { expectedVersion: 0, metadata: { headers: { $a: 'b' } } }, InvalidEventMetadataException],
		['an invalid expected version', { expectedVersion: -1 }, InvalidAppendOptionsException],
	])('rejects %s in the options form, without calling the store', async (_description, options, exception, fields) => {
		const error = await base()
			.appendEvents(eventStreamAccountA, events.slice(0, 1), options as never)
			.catch((e) => e);

		expect(error).toBeInstanceOf(exception);
		if (fields) {
			expect(error).toMatchObject(fields);
		}
		expect(store.appended).toEqual([]);
	});

	it('accepts empty metadata in the options form', async () => {
		await base().appendEvents(eventStreamAccountA, events.slice(0, 1), {
			expectedVersion: 0,
			metadata: { correlationId: undefined, headers: {} },
		});

		expect(store.appended).toHaveLength(1);
	});

	it('checks the pre-built envelopes of the options form', async () => {
		const eventMap = getEventMap();
		const envelope = (version: number, headers?: Record<string, string>) =>
			EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: eventStreamAccountA.aggregateId,
				version,
				headers,
			});

		await expect(
			base().appendEvents(eventStreamAccountA, [envelope(2)], { expectedVersion: 0 }),
		).rejects.toBeInstanceOf(InvalidEventEnvelopeException);
		await expect(
			base().appendEvents(eventStreamAccountA, [envelope(1, { $trace: 'x' })], { expectedVersion: 0 }),
		).rejects.toBeInstanceOf(UnsupportedOperationException);
		expect(store.appended).toEqual([]);

		await base().appendEvents(eventStreamAccountA, [envelope(1)], { expectedVersion: 0 });
		expect(store.appended).toHaveLength(1);
	});

	it('checks the metadata of an empty append in the options form', async () => {
		await expect(
			base().appendEvents(eventStreamAccountA, [], { expectedVersion: 0, metadata: { headers: { $x: 'y' } } }),
		).rejects.toBeInstanceOf(InvalidEventMetadataException);
		await expect(
			base().appendEvents(eventStreamAccountA, [], { expectedVersion: 0, metadata: { correlationId: 1 as never } }),
		).rejects.toBeInstanceOf(InvalidEventMetadataException);
		expect(store.appended).toEqual([]);
	});

	describe('pre-built envelopes', () => {
		const eventMap = getEventMap();
		const envelope = (version: number, metadata: Record<string, unknown> = {}) =>
			EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: eventStreamAccountA.aggregateId,
				version,
				correlationId: 'imported',
				...metadata,
			});
		const forwardedItems = (index = 0) => store.appended[index].args[2] as EventEnvelope[];

		it('passes them on in the options form without their global position, and the events among them as envelopes', async () => {
			const imported = envelope(3).withGlobalPosition(42n);

			await base().appendEvents(eventStreamAccountA, [imported, events[1]], { expectedVersion: 2 });
			await base().appendEvents(eventStreamAccountA, [events[1], imported], { expectedVersion: 1 });

			const [first, second] = [forwardedItems(0), forwardedItems(1)];
			expect(store.appended.map(({ args }) => args[1])).toEqual([4, 3]);
			expect(first.map(({ metadata }) => metadata.version)).toEqual([3, 4]);
			expect(second.map(({ metadata }) => metadata.version)).toEqual([2, 3]);
			for (const items of [first, second]) {
				expect(items.every((item) => item instanceof EventEnvelope)).toBe(true);
				const forwarded = items.find(({ metadata }) => metadata.eventId === imported.metadata.eventId);
				expect(forwarded?.metadata).toEqual({
					eventId: imported.metadata.eventId,
					aggregateId: eventStreamAccountA.aggregateId,
					version: 3,
					occurredOn: imported.metadata.occurredOn,
					correlationId: 'imported',
				});
				const event = items.find((item) => item !== forwarded) as EventEnvelope;
				expect(event).toMatchObject({
					event: eventMap.getName(events[1]),
					payload: eventMap.serializeEvent(events[1]),
				});
				expect(event.metadata.aggregateId).toBe(eventStreamAccountA.aggregateId);
			}
			// The input is left as it was
			expect(imported.metadata.globalPosition).toBe(42n);
		});

		it('passes them on in the positional form as 3.x did, only without their global position', async () => {
			const copied = envelope(7, { aggregateId: 'another-aggregate' }).withGlobalPosition(42n);

			await base().appendEvents(eventStreamAccountA, 2, [copied, events[1]]);

			const [forwarded, event] = forwardedItems();
			expect(forwarded).toBeInstanceOf(EventEnvelope);
			expect(forwarded.metadata).toEqual({
				eventId: copied.metadata.eventId,
				aggregateId: 'another-aggregate',
				version: 7,
				occurredOn: copied.metadata.occurredOn,
				correlationId: 'imported',
			});
			expect(event).toBe(events[1]);
		});

		it('passes events without envelopes on as they are', async () => {
			await base().appendEvents(eventStreamAccountA, events.slice(0, 2), { expectedVersion: 0 });

			expect(forwardedItems()).toEqual(events.slice(0, 2));
		});

		it.each<[string, EventEnvelope, Record<string, unknown>]>([
			['headers', envelope(1, { headers: { $trace: 'x' } }), { operation: 'headers' }],
			['an event version', envelope(1, { eventVersion: 2 }), { operation: 'eventVersion' }],
		])('rejects envelopes with %s in both forms, without calling the store', async (_, item, fields) => {
			for (const append of [
				base().appendEvents(eventStreamAccountA, [item], { expectedVersion: 0 }),
				base().appendEvents(eventStreamAccountA, 1, [item]),
			]) {
				const error = await append.catch((e: unknown) => e);
				expect(error).toBeInstanceOf(UnsupportedOperationException);
				expect(error).toMatchObject(fields);
			}
			expect(store.appended).toEqual([]);
		});
	});

	describe('a store that overrides appendEvents and calls the base class', () => {
		class DelegatingEventStore extends InMemoryEventStore {
			async appendEvents(stream: EventStream, ...args: AppendEventsArguments): Promise<EventEnvelope[]> {
				return super.appendEvents(stream, ...args);
			}
		}

		it('publishes every append once, and nothing with publish: false', async () => {
			const delegating = new DelegatingEventStore(createTestContext(getEventMap(), publish), {
				driver: InMemoryEventStore,
			});
			await delegating.connect();
			await delegating.ensureCollection();
			expect(isLegacyEventStore(delegating)).toBe(true);
			const through = delegating as EventStore<unknown>;

			const positional = await through.appendEvents(eventStreamAccountA, 2, events.slice(0, 2));
			expect(publish.mock.calls).toEqual(positional.map((envelope) => [envelope]));

			await through.appendEvents(eventStreamAccountA, events.slice(2, 3), { expectedVersion: 2, publish: false });
			expect(publish).toHaveBeenCalledTimes(2);

			const withOptions = await through.appendEvents(eventStreamAccountA, events.slice(3, 4), { expectedVersion: 3 });
			expect(publish).toHaveBeenCalledTimes(3);
			expect(publish).toHaveBeenLastCalledWith(withOptions[0]);
		});
	});

	it('resolves and logs when publishing fails', async () => {
		publish.mockRejectedValue(new Error('publish failure'));

		const envelopes = await base().appendEvents(eventStreamAccountA, 1, events.slice(0, 1));

		expect(envelopes).toHaveLength(1);
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to publish 1 appended event(s)',
			expect.stringContaining('publish failure'),
		);
	});

	it('lets the errors of the store through, and publishes nothing', async () => {
		const failure = new Error('insert failed');
		vi.spyOn(LegacyEventStore.prototype, 'appendEvents').mockRejectedValueOnce(failure);

		await expect(base().appendEvents(eventStreamAccountA, 1, events.slice(0, 1))).rejects.toBe(failure);
		expect(publish).not.toHaveBeenCalled();
	});

	it('leaves the driver methods it lacks unsupported', async () => {
		await expect(store.getStreamVersion(eventStreamAccountA)).rejects.toBeInstanceOf(UnsupportedOperationException);
		await expect(store['persistEvents']([], {} as never)).rejects.toMatchObject({ operation: 'persistEvents' });
		const readAll = store.readAll();
		await expect(readAll.next()).rejects.toMatchObject({ operation: 'readAll', component: 'LegacyEventStore' });
		const getAllEnvelopes = store.getAllEnvelopes({ since: { year: 2021, month: 1 } });
		await expect(getAllEnvelopes.next()).rejects.toMatchObject({ operation: 'getAllEnvelopes' });
	});
});
