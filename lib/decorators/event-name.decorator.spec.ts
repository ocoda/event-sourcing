import { IEvent } from '../interfaces';
import { EVENT_NAME_METADATA } from './constants';
import { EventName } from './event-name.decorator';

describe('@EventName', () => {
  @EventName('foo-created')
  class FooCreated implements IEvent {}

  it('should determine the name of an event from the constructor', () => {
    const eventName = Reflect.getMetadata(EVENT_NAME_METADATA, FooCreated);
    expect(eventName).toEqual('foo-created');
  });
});
