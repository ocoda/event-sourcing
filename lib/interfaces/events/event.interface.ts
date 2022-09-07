export interface IEvent {}

export type IEventPayload<E extends IEvent> = Record<keyof E, any>;
