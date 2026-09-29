import type { Type } from '@nestjs/common';
import type { IEvent, IEventPayload } from './event.interface.js';

export interface IEventSerializer<E extends IEvent = IEvent> {
	serialize(event: E): IEventPayload<E>;
	deserialize(payload: IEventPayload<E>): E;
}

/**
 * Creates the serializer of an event class. `JsonEventSerializer` and `ClassTransformerEventSerializer` are factories
 * (`JsonEventSerializer.for(AccountOpenedEvent)`), and `defaultEventSerializer` in `EventSourcingModule.forRoot()`
 * takes one: it serializes every event that has no `@EventSerializer()` of its own.
 */
export interface EventSerializerFactory {
	for<E extends IEvent>(event: Type<E>): IEventSerializer<E>;
}
