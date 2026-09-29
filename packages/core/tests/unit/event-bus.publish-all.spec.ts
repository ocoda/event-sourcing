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
		const publisher = { publish: vi.fn(), publishAll: vi.fn(async () => undefined) } satisfies IEventPublisher;
		bus.addPublisher(publisher);

		await bus.publishAll([]);

		expect(publisher.publish).not.toHaveBeenCalled();
		expect(publisher.publishAll).not.toHaveBeenCalled();
	});

	it('awaits asynchronous publishers, one envelope after the other', async () => {
		const bus = new EventBus();
		const calls: string[] = [];
		const releases: (() => void)[] = [];
		bus.addPublisher({
			publish: (envelope: EventEnvelope) => {
				calls.push(`start ${envelope.metadata.version}`);
				return new Promise<void>((resolve) =>
					releases.push(() => {
						calls.push(`end ${envelope.metadata.version}`);
						resolve();
					}),
				);
			},
		});
		let resolved = false;

		const publishing = bus.publishAll([envelopeFor(1), envelopeFor(2)]).then(() => (resolved = true));
		await Promise.resolve();
		expect(calls).toEqual(['start 1']);
		releases.shift()?.();
		await vi.waitFor(() => expect(calls).toEqual(['start 1', 'end 1', 'start 2']));
		expect(resolved).toBe(false);
		releases.shift()?.();
		await publishing;

		expect(calls).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
	});

	it('never rejects, and keeps publishing the later envelopes to a publisher that failed on one', async () => {
		const bus = new EventBus();
		const envelopes = [envelopeFor(1), envelopeFor(2, 'publish-all-poisoned'), envelopeFor(3)];
		const publisher = {
			publish: vi.fn((envelope: EventEnvelope) => {
				if (envelope.event === 'publish-all-poisoned') {
					throw new Error('publish failure');
				}
			}),
		};
		bus.addPublisher(publisher);

		await expect(bus.publishAll(envelopes)).resolves.toBeUndefined();

		expect(publisher.publish.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
		expect(loggerError).toHaveBeenCalledTimes(1);
		expect(loggerError.mock.calls[0][0]).toBe('Event publisher Object failed to publish event "publish-all-poisoned"');
		expect(loggerError.mock.calls[0][1]).toContain('publish failure');
	});

	it('logs publishers that throw or reject', async () => {
		const bus = new EventBus();
		bus.addPublisher({
			publish: () => {
				throw new Error('sync publisher failure');
			},
		});
		bus.addPublisher({ publish: async () => Promise.reject(new Error('async publisher failure')) });

		await expect(bus.publishAll([envelopeFor(1)])).resolves.toBeUndefined();

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
