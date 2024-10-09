import { Event, type IEvent, InvalidEventStreamNameException } from '@ocoda/event-sourcing';
import { getEventMetadata } from '@ocoda/event-sourcing/helpers';

describe('@Event', () => {
	@Event('foo-created')
	class FooCreated implements IEvent {}

	@Event()
	class BarCreated implements IEvent {}

	it('should determine the name of an event from the constructor', () => {
		const { name: explicitEventName } = getEventMetadata(FooCreated);
		expect(explicitEventName).toEqual('foo-created');

		const { name: implicitEventName } = getEventMetadata(BarCreated);
		expect(implicitEventName).toEqual('BarCreated');
	});

	it('should throw when an event name exceeds 80 characters', () => {
		const decorate = (length: number) => {
			@Event('a'.repeat(length))
			class InvalidEvent implements IEvent {}
		};

		expect(() => decorate(80)).not.toThrow();
		expect(() => decorate(81)).toThrow(InvalidEventStreamNameException.becauseExceedsMaxLength('InvalidEvent', 80));
	});
});
