import { getEventSerializerMetadata } from '@ocoda/event-sourcing/helpers/get-event-serializer-metadata';
import { EventSerializer, IEvent } from '../../../lib';

describe('@EventSerializer', () => {
	class AccountCreatedEvent implements IEvent {}

	@EventSerializer(AccountCreatedEvent)
	class AccountCreatedEventSerializer {}

	it('should specify which event the event-serializer serializes', () => {
		const event: IEvent = getEventSerializerMetadata(AccountCreatedEventSerializer);
		expect(event).toEqual(AccountCreatedEvent);
	});
});
