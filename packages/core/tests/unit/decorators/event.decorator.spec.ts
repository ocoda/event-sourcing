import { Event, IEvent } from '@ocoda/event-sourcing';
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
});
