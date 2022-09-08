import { EventName, EVENT_NAME_METADATA, IEvent } from '../../../lib';

describe('@EventName', () => {
	@EventName('foo-created')
	class FooCreated implements IEvent {}

	it('should determine the name of an event from the constructor', () => {
		const eventName = Reflect.getMetadata(EVENT_NAME_METADATA, FooCreated);
		expect(eventName).toEqual('foo-created');
	});
});
