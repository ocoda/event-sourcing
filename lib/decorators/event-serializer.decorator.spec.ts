import { ICommand, IEvent } from '../interfaces';
import { CommandHandler } from './command-handler.decorator';
import {
  COMMAND_HANDLER_METADATA,
  COMMAND_METADATA,
  EVENT_SERIALIZER_METADATA,
} from './constants';
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
