import type { IEvent, IEventPayload } from './event.interface.js';

export interface IEventSerializer<E extends IEvent = IEvent> {
	serialize(event: E): IEventPayload<E>;
	deserialize(payload: IEventPayload<E>): E;
}
