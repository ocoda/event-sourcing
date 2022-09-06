import { instanceToPlain, plainToInstance } from 'class-transformer';
import { Type } from '@nestjs/common';
import { IEvent, IEventSerializer } from '../interfaces';

export class DefaultEventSerializer<E extends IEvent = IEvent> implements IEventSerializer {
	private constructor(private readonly eventType: Type<E>) {}

	static for<E extends IEvent = IEvent>(cls: Type<E>): DefaultEventSerializer<E> {
		return new DefaultEventSerializer(cls);
	}

	serialize(event: IEvent): Record<string, any> {
		return instanceToPlain(event);
	}

	deserialize(payload: Record<string, any>): E {
		return plainToInstance<E, Record<string, any>>(this.eventType, payload);
	}
}
