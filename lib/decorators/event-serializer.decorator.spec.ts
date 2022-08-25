import { IEvent } from '../interfaces';
import { EVENT_SERIALIZER_METADATA } from './constants';
import { EventSerializer } from './event-serializer.decorator';

describe('@EventSerializer', () => {
  class AccountCreatedEvent implements IEvent {}

  @EventSerializer(AccountCreatedEvent)
  class AccountCreatedEventSerializer {}

  it('should specify which event the event-serializer serializes', () => {
    const event: IEvent = Reflect.getMetadata(
      EVENT_SERIALIZER_METADATA,
      AccountCreatedEventSerializer,
    );
    expect(event).toEqual(AccountCreatedEvent);
  });
});
