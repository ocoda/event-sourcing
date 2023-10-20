import { EventSerializer, IEvent, IEventPayload, IEventSerializer } from '../../../lib';
import { getEventSerializerMetadata } from '../../../lib/helpers';

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
