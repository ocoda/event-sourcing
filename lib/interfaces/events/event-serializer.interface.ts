import { IEvent, IEventPayload } from './event.interface';

export interface IEventSerializer<E extends IEvent = IEvent> {
	serialize(event: E): IEventPayload<E>;
	deserialize(payload: IEventPayload<E>): E;
}
