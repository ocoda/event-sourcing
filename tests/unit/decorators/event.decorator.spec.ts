import { Event, IEvent } from '../../../lib';
import { getEventMetadata } from '../../../lib/helpers';

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
