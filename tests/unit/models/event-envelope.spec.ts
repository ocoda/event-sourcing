import { EventEnvelope, Id, IEvent } from '../../../lib';

describe(EventEnvelope, () => {
	const now = new Date();

	class FooId extends Id {}
	class FooCreatedEvent implements IEvent {
		constructor(public readonly bar: string) {}
	}

	beforeAll(() => jest.spyOn(global.Date, 'now').mockImplementationOnce(() => now.valueOf()));

	it('should create an event-envelope', () => {
		const fooId = FooId.generate();
		const fooCreatedEvent = new FooCreatedEvent('bar');

		const envelope = EventEnvelope.new(fooId, 1, 'foo-created', Object.assign({}, fooCreatedEvent));

		expect(envelope.eventId).toBeDefined();
		expect(envelope.eventName).toBe('foo-created');
		expect(envelope.payload).toEqual({ bar: 'bar' });
		expect(envelope.metadata.aggregateId).toEqual(fooId.value);
		expect(envelope.metadata.sequence).toBe(1);
		expect(envelope.metadata.occurredOn).toEqual(now.valueOf());
	});
});
