import type { IEvent } from '../events/index.js';

export type IEventHandlerMethod<E extends IEvent> = (event: E) => void;
