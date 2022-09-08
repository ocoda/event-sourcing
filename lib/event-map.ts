import { Injectable, Type } from '@nestjs/common';
import { EVENT_NAME_METADATA } from './decorators';
import { MissingEventMetadataException, UnregisteredEventException, UnregisteredSerializerException } from './exceptions';
import { IEvent, IEventPayload, IEventSerializer } from './interfaces';

export type EventSerializerType = Type<IEventSerializer<IEvent>>;

type IEventName = string;
type IEventConstructor<E extends IEvent = IEvent> = Type<E>;
type IEventInstance<E extends IEvent = IEvent> = E;

interface IEventData<E extends IEvent> {
	name: IEventName;
	cls: IEventConstructor<E>;
	serializer?: IEventSerializer<E>;
}

export type IEventMapTarget<E extends IEvent = IEvent> = IEventName | IEventConstructor<E> | IEventInstance<E>;

@Injectable()
export class EventMap {
	private readonly eventMap: Set<IEventData<unknown>> = new Set();

	public register<E extends IEvent>(cls: IEventConstructor<E>, serializer?: IEventSerializer): void {
		const name: string = Reflect.getMetadata(EVENT_NAME_METADATA, cls);
		if (!name) {
			throw new MissingEventMetadataException(cls);
		}

		this.eventMap.add({ name, cls, serializer });
	}

	private get<E extends IEvent>(target: IEventMapTarget<E>): IEventData<E> {
		for (const helper of this.eventMap) {
			if(
				(typeof target === 'string' && target === helper.name) ||
				(typeof target === 'object' && target.constructor === helper.cls) ||
				(typeof target === 'function' && target === helper.cls)
			) {
				return helper as IEventData<E>;
			}
		}

		throw new UnregisteredEventException(target);
	}

	public has<E extends IEvent>(target: IEventMapTarget<E>): boolean {
		for (const helper of this.eventMap) {
			if(
				(typeof target === 'string' && target === helper.name) ||
				(typeof target === 'object' && target.constructor === helper.cls) ||
				(typeof target === 'function' && target === helper.cls)
			) {
				return true;
			}
		}
		return false;
	}

	public serializeEvent<E extends IEvent>(event: IEventInstance<E>): IEventPayload<E> {
		const { name, serializer } = this.get<E>(event);

		if(!serializer) {
			throw new UnregisteredSerializerException(name)
		}

		return serializer.serialize(event);
	}

	public deserializeEvent<E extends IEvent>(eventName: IEventName, payload: IEventPayload<E>): IEventInstance<E> {
		const { serializer } = this.get<E>(eventName);

		if(!serializer) {
			throw new UnregisteredSerializerException(eventName)
		}

		return serializer.deserialize(payload);
	}

	public getConstructor<E extends IEvent>(target: IEventInstance<E> | IEventName): IEventConstructor<E> {
		const { cls } = this.get(target);

		return cls;
	}

	public getName<E extends IEvent>(target: IEventConstructor<E> | IEventInstance<E>): IEventName {
		const { name } = this.get(target);

		return name;
	}
}
