import { IEvent } from './event.interface';

export interface IEventSerializer<
	BaseEvent extends IEvent = IEvent,
	Payload extends Record<string, unknown> = Record<string, unknown>,
> {
	serialize: (event: BaseEvent) => Payload;
	deserialize: (payload: Payload, ...params) => BaseEvent;
}
