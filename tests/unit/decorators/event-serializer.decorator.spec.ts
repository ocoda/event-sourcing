import { EventSerializer, IEvent } from '../../../lib';
import { getEventSerializerMetadata } from '../../../lib/helpers';

describe('@EventSerializer', () => {
	class AccountCreatedEvent implements IEvent {}

	@EventSerializer(AccountCreatedEvent)
	class AccountCreatedEventSerializer {}

	it('should specify which event the event-serializer serializes', () => {
		const event: IEvent = getEventSerializerMetadata(AccountCreatedEventSerializer);
		expect(event).toEqual(AccountCreatedEvent);
	});
});
