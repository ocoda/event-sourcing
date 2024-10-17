import { EventSerializer, type IEvent, type IEventSerializer, getEventSerializerMetadata } from '@ocoda/event-sourcing';

describe('@EventSerializer', () => {
	class AccountCreatedEvent implements IEvent {}

	@EventSerializer(AccountCreatedEvent)
	class AccountCreatedEventSerializer implements IEventSerializer {
		serialize() {
			return {};
		}
		deserialize() {
			return {};
		}
	}

	it('should specify which event the event-serializer serializes', () => {
		const event: IEvent = getEventSerializerMetadata(AccountCreatedEventSerializer);
		expect(event).toEqual(AccountCreatedEvent);
	});
});
