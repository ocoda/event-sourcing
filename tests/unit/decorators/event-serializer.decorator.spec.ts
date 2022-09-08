import { EventSerializer, EVENT_SERIALIZER_METADATA, IEvent } from '../../../lib';

describe('@EventSerializer', () => {
	class AccountCreatedEvent implements IEvent {}

	@EventSerializer(AccountCreatedEvent)
	class AccountCreatedEventSerializer {}

	it('should specify which event the event-serializer serializes', () => {
		const event: IEvent = Reflect.getMetadata(EVENT_SERIALIZER_METADATA, AccountCreatedEventSerializer);
		expect(event).toEqual(AccountCreatedEvent);
	});
});
