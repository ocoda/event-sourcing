import { Event, EVENT_METADATA, IEvent } from '../../../lib';

describe('@Event', () => {
	@Event('foo-created')
	class FooCreated implements IEvent {}

	@Event()
	class BarCreated implements IEvent {}

	it('should determine the name of an event from the constructor', () => {
		const explicitEventName = Reflect.getMetadata(EVENT_METADATA, FooCreated);
		expect(explicitEventName).toEqual('foo-created');

		const implicitEventName = Reflect.getMetadata(EVENT_METADATA, BarCreated);
		expect(implicitEventName).toEqual('BarCreated');
	});
});
