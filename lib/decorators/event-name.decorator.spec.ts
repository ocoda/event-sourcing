import { IEvent, IEventSerializer } from '../interfaces';
import { EVENT_METADATA } from './constants';
import { EventName } from './event-name.decorator';

describe('@Event', () => {
  it('Adds event metadata to a decorated event class', () => {
    @EventName('test-created')
    class TestCreatedEvent implements IEvent {
      propA: string;
      propB: string;
    }

    const classEventName = Reflect.getMetadata(
      EVENT_METADATA,
      TestCreatedEvent,
    );

    expect(classEventName).toEqual('test-created');

    const instanceEventName = Reflect.getMetadata(
      EVENT_METADATA,
      new TestCreatedEvent().constructor,
    );
    expect(instanceEventName.name).toEqual('test-created');
  });
});
