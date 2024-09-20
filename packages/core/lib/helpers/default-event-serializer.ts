import type { Type } from '@nestjs/common';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import type { IEvent, IEventPayload, IEventSerializer } from '../interfaces';

export class DefaultEventSerializer<E extends IEvent = IEvent> implements IEventSerializer {
	private constructor(private readonly eventType: Type<E>) {}

	static for<E extends IEvent = IEvent>(cls: Type<E>): DefaultEventSerializer<E> {
		return new DefaultEventSerializer(cls);
	}

	serialize(event: E): IEventPayload<E> {
		return instanceToPlain<E>(event) as IEventPayload<E>;
	}

	deserialize(payload: IEventPayload<E>): E {
		return plainToInstance<E, IEventPayload<E>>(this.eventType, payload);
	}
}
