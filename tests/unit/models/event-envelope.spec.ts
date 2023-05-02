import { EventEnvelope, IEvent, UUID } from '../../../lib';

describe(EventEnvelope, () => {
	class FooId extends UUID {}
	class FooCreatedEvent implements IEvent {
		constructor(public readonly bar: string) {}
	}

	it('should create an event-envelope', () => {
		const fooId = FooId.generate();
		const fooCreatedEvent = new FooCreatedEvent('bar');

		const envelope = EventEnvelope.create('foo-created', Object.assign({}, fooCreatedEvent), {
			aggregateId: fooId.value,
			version: 1,
		});

		expect(envelope.event).toBe('foo-created');
		expect(envelope.payload).toEqual({ bar: 'bar' });
		expect(envelope.metadata.aggregateId).toEqual(fooId.value);
		expect(envelope.metadata.version).toBe(1);
		expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
	});
});
