import { Inject, Injectable, Optional, type Type } from '@nestjs/common';
import {
	EventSerializationException,
	MissingEventMetadataException,
	UnregisteredEventException,
	UnregisteredSerializerException,
} from './exceptions/index.js';
import { type ClassTransformerDecoratorsOf, checkNestedClasses } from './helpers/class-transformer-decorators.js';
import { JsonEventSerializer, getEventMetadata, getEventSerializerMetadata } from './helpers/index.js';
import type {
	EventSerializerFactory,
	IEvent,
	IEventPayload,
	IEventSerializer,
	ProviderWrapper,
} from './interfaces/index.js';
import { providerClassOf } from './registration/providers.js';
import { EVENT_SOURCING_REGISTRATION, type Registration } from './registration/registration.js';

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
	private readonly eventMap: Set<IEventData<IEvent>> = new Set();

	/**
	 * @param registration In the `EventSourcingModule`: registers the events and serializers of the application on the
	 * first lookup, if the module hasn't yet. A map created with `new EventMap()` has none; register its events yourself.
	 */
	constructor(@Optional() @Inject(EVENT_SOURCING_REGISTRATION) private readonly registration?: Registration) {}

	/**
	 * In the `EventSourcingModule`: registers the events, serializers, handlers, subscribers and publishers of the
	 * application, unless that happened already. The event store calls it before an append or a read of events does any
	 * I/O, also when no lookup is needed (an append of pre-built envelopes). Does nothing for a map created with
	 * `new EventMap()`.
	 *
	 * @param operation what triggered it, for the error message
	 * @throws EventSourcingNotReadyException while Nest is still instantiating the providers
	 * @throws EventSourcingConfigurationException listing every problem with the configuration
	 * @internal Used by the `EventStore` template.
	 */
	ensureRegistered(operation: string): void {
		this.registration?.ensureRegistered(operation);
	}

	public register<E extends IEvent>(cls: IEventConstructor<E>, serializer?: IEventSerializer): void {
		const { name } = getEventMetadata(cls);

		if (!name) {
			throw new MissingEventMetadataException({ event: cls });
		}

		this.eventMap.add({ name, cls, serializer });
	}

	private get<E extends IEvent>(target: IEventMapTarget<E>): IEventData<E> {
		this.registration?.ensureRegistered('The EventMap (appendEvents, getEvent, getEvents)');
		for (const helper of this.eventMap) {
			if (
				(typeof target === 'string' && target === helper.name) ||
				(typeof target === 'object' && target.constructor === helper.cls) ||
				(typeof target === 'function' && target === helper.cls)
			) {
				return helper as IEventData<E>;
			}
		}

		throw new UnregisteredEventException({ event: target });
	}

	public has<E extends IEvent>(target: IEventMapTarget<E>): boolean {
		this.registration?.ensureRegistered('The EventMap (appendEvents, getEvent, getEvents)');
		for (const helper of this.eventMap) {
			if (
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

		if (!serializer) {
			throw new UnregisteredSerializerException({ eventName: name });
		}

		return serializer.serialize(event);
	}

	public deserializeEvent<E extends IEvent>(eventName: IEventName, payload: IEventPayload<E>): IEventInstance<E> {
		const { serializer } = this.get<E>(eventName);

		if (!serializer) {
			throw new UnregisteredSerializerException({ eventName });
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

	/**
	 * Registers the events with their serializer: the `@EventSerializer()` provider for the event if there is one,
	 * otherwise one from `defaultSerializer` (`JsonEventSerializer` unless `EventSourcingModule.forRoot()` sets
	 * `defaultEventSerializer`).
	 *
	 * @throws EventSerializationException when an event would get a `JsonEventSerializer` although it carries
	 * class-transformer decorators, which that serializer ignores. `classTransformerDecoratorsOf` finds them; without
	 * it, nothing is checked. With it, the JSON serializers registered here also refuse, when they serialize, an event
	 * that holds an instance of a class whose decorators would have shaped the payload. In the `EventSourcingModule`,
	 * the registration reports every such event as a `class-transformer-decorators` issue of an
	 * `EventSourcingConfigurationException` before it calls this.
	 */
	registerSerializers(
		events: Type<IEvent>[] = [],
		serializers: ProviderWrapper<IEventSerializer>[] = [],
		{
			defaultSerializer = JsonEventSerializer,
			classTransformerDecoratorsOf,
		}: { defaultSerializer?: EventSerializerFactory; classTransformerDecoratorsOf?: ClassTransformerDecoratorsOf } = {},
	) {
		for (const event of events) {
			// The class of the serializer is that of its instance, so that factory and value providers are found too
			const handler = serializers.find((wrapper) => {
				const type = providerClassOf(wrapper);
				return !!type && getEventSerializerMetadata(type as Type<IEventSerializer>)?.event === event;
			});

			const custom = handler?.instance as IEventSerializer | undefined;
			const serializer = custom ?? defaultSerializer.for(event);

			if (!custom && serializer instanceof JsonEventSerializer && classTransformerDecoratorsOf) {
				const decorators = classTransformerDecoratorsOf(event);
				// Only reached by a direct call: the module's registration plan lists these events as configuration issues
				if (decorators.length > 0) {
					throw new EventSerializationException({
						event: event.name,
						reason: 'class-transformer-decorators',
						decorators,
					});
				}
				checkNestedClasses(serializer, classTransformerDecoratorsOf);
			}

			this.register(event, serializer);
		}
	}
}
