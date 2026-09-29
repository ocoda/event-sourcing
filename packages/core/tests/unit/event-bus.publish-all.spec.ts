import { Logger } from '@nestjs/common';
import {
	type EnvelopePublisher,
	EventBus,
	EventEnvelope,
	type IEventPublisher,
	type IEventSubscriber,
} from '@ocoda/event-sourcing';
import type { MockInstance } from 'vitest';

describe('EventBus.publishAll', () => {
	const envelopeFor = (version: number, event = 'publish-all-recorded') =>
		EventEnvelope.create(event, {}, { aggregateId: 'a', version });

	let loggerError: MockInstance;

	beforeEach(() => {
		loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
	});

	it('is the envelope publisher an event store gets', () => {
		const publisher: EnvelopePublisher = new EventBus();

		expectTypeOf(publisher.publishAll).returns.toEqualTypeOf<Promise<void>>();
	});

	it('publishes the envelopes of an append in order to every publisher and subscriber', async () => {
		const bus = new EventBus();
		const publisher = { publish: vi.fn() } satisfies IEventPublisher;
		const subscriber = { handle: vi.fn() } satisfies IEventSubscriber;
		bus.addPublisher(publisher);
		bus.bind(subscriber, '');
		const envelopes = [envelopeFor(1), envelopeFor(2), envelopeFor(3)];

		await expect(bus.publishAll(envelopes)).resolves.toBeUndefined();

		expect(publisher.publish.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
		expect(subscriber.handle.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
	});

	it('does nothing for an empty append', async () => {
		const bus = new EventBus();
		const publish = vi.spyOn(bus, 'publish');

		await bus.publishAll([]);

		expect(publish).not.toHaveBeenCalled();
	});

	it('keeps the fire-and-forget semantics of publish: asynchronous publishers are not awaited', async () => {
		const bus = new EventBus();
		let release: () => void = () => undefined;
		const publisher = {
			publish: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
		} satisfies IEventPublisher;
		bus.addPublisher(publisher);

		await bus.publishAll([envelopeFor(1), envelopeFor(2)]);

		expect(publisher.publish).toHaveBeenCalledTimes(2);
		release();
	});

	it('never rejects, and keeps publishing the other envelopes when one fails', async () => {
		const bus = new EventBus();
		const envelopes = [envelopeFor(1), envelopeFor(2, 'publish-all-poisoned'), envelopeFor(3)];
		const published: EventEnvelope[] = [];
		// A replaced publish function, which may throw unlike the bus' own
		bus.publish = (envelope) => {
			if (envelope.event === 'publish-all-poisoned') {
				throw new Error('publish failure');
			}
			published.push(envelope);
		};

		await expect(bus.publishAll(envelopes)).resolves.toBeUndefined();

		expect(published).toEqual([envelopes[0], envelopes[2]]);
		expect(loggerError).toHaveBeenCalledTimes(1);
		expect(loggerError.mock.calls[0][0]).toBe('Failed to publish event "publish-all-poisoned"');
		expect(loggerError.mock.calls[0][1]).toContain('publish failure');
	});

	it('logs publishers that throw or reject, like publish', async () => {
		const bus = new EventBus();
		bus.addPublisher({
			publish: () => {
				throw new Error('sync publisher failure');
			},
		});
		bus.addPublisher({ publish: async () => Promise.reject(new Error('async publisher failure')) });

		await expect(bus.publishAll([envelopeFor(1)])).resolves.toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(loggerError.mock.calls.map(([, trace]) => trace)).toEqual([
			expect.stringContaining('sync publisher failure'),
			expect.stringContaining('async publisher failure'),
		]);
	});

	it('never rejects for a value that is not a list of envelopes', async () => {
		const bus = new EventBus();

		await expect(bus.publishAll(undefined as never)).resolves.toBeUndefined();
		await expect(bus.publishAll(42 as never)).resolves.toBeUndefined();
		expect(loggerError).toHaveBeenCalledTimes(1);
		expect(loggerError.mock.calls[0][0]).toBe('Failed to publish the envelopes of an append');
	});
});
