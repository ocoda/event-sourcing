import type { Type } from '@nestjs/common';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import type { IEvent, IEventPayload, IEventSerializer } from '../interfaces/index.js';

/**
 * Serializes events with class-transformer (`instanceToPlain` and `plainToInstance`), as the default serializer of
 * 3.x (`DefaultEventSerializer`) did, so class-transformer decorators such as `@Type`, `@Transform`, `@Expose` and
 * `@Exclude` apply. Needs the `class-transformer` package (^0.5.1), an optional peer dependency.
 *
 * Use it for every event that has no `@EventSerializer()` of its own:
 *
 * @example
 * import { ClassTransformerEventSerializer } from '@ocoda/event-sourcing/class-transformer';
 *
 * EventSourcingModule.forRoot({ events, defaultEventSerializer: ClassTransformerEventSerializer });
 *
 * @example
 * // or for one event
 * eventMap.register(FundsDepositedEvent, ClassTransformerEventSerializer.for(FundsDepositedEvent));
 */
export class ClassTransformerEventSerializer<E extends IEvent = IEvent> implements IEventSerializer<E> {
	protected constructor(protected readonly eventType: Type<E>) {}

	static for<E extends IEvent>(event: Type<E>): ClassTransformerEventSerializer<E> {
		return new ClassTransformerEventSerializer(event);
	}

	serialize(event: E): IEventPayload<E> {
		return instanceToPlain(event) as IEventPayload<E>;
	}

	deserialize(payload: IEventPayload<E>): E {
		return plainToInstance(this.eventType, payload);
	}
}
