import type { IEvent } from '../events';

export type IEventHandlerMethod<E extends IEvent> = (event: E) => void;
