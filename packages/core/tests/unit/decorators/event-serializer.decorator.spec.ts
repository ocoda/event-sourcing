import type { Type } from '@nestjs/common';
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
		const { event } = getEventSerializerMetadata(AccountCreatedEventSerializer);
		expect(event).toEqual(AccountCreatedEvent);
	});

	it('takes an event class (ADR 0001 §7)', () => {
		// Never called: checked by the compiler only.
		const compileTimeOnly = () => {
			// @ts-expect-error an event name is not an event class
			@EventSerializer('AccountCreatedEvent')
			class _NameSerializer {}
		};

		expectTypeOf(compileTimeOnly).toBeFunction();
		expectTypeOf(EventSerializer).parameters.toEqualTypeOf<[Type<IEvent>]>();
	});
});
