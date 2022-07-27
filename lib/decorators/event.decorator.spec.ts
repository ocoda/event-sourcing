import { IEvent, IEventSerializer } from '../interfaces';
import { EVENT_METADATA } from './constants';
import { Event, EventMetadata } from './event.decorator';

describe('@Event', () => {
  it('Adds event metadata to a decorated event class', () => {
    const testCreatedEventSerializer: IEventSerializer<TestCreatedEvent> = {
      serialize: ({ propA, propB }) => ({ A: propA, B: propB }),
      deserialize: ({ A, B }: Record<string, unknown>) => ({
        propA: A,
        propB: B,
      }),
    };

    @Event({ name: 'test-created', serializer: testCreatedEventSerializer })
    class TestCreatedEvent implements IEvent {
      propA: string;
      propB: string;
    }

    const classMetadata: EventMetadata = Reflect.getMetadata(
      EVENT_METADATA,
      TestCreatedEvent,
    );

    expect(classMetadata.name).toEqual('test-created');
    expect(classMetadata.serializer).toEqual(testCreatedEventSerializer);

    const instanceMetadata: EventMetadata = Reflect.getMetadata(
      EVENT_METADATA,
      new TestCreatedEvent().constructor,
    );
    expect(instanceMetadata.name).toEqual('test-created');
    expect(instanceMetadata.serializer).toEqual(testCreatedEventSerializer);
  });
});
