import { Scope, type Type } from '@nestjs/common';
import {
	COMMAND_HANDLER_METADATA,
	EVENT_PUBLISHER_METADATA,
	EVENT_SERIALIZER_METADATA,
	EVENT_SUBSCRIBER_METADATA,
	QUERY_HANDLER_METADATA,
} from '../decorators/constants.js';
import type { EventSourcingConfigurationIssue } from '../exceptions/index.js';
import { describeValue } from '../exceptions/internal.js';
import type { ClassTransformerDecoratorsOf } from '../helpers/class-transformer-decorators.js';
import { JsonEventSerializer } from '../helpers/json-event-serializer.js';
import {
	getCommandHandlerMetadata,
	getEventMetadata,
	getEventSerializerMetadata,
	getEventSubscriberMetadata,
	getQueryHandlerMetadata,
} from '../helpers/metadata/index.js';
import type {
	EventSerializerFactory,
	ICommandHandler,
	IEvent,
	IEventPublisher,
	IEventSerializer,
	IEventSubscriber,
	IQueryHandler,
	ProviderWrapper,
} from '../interfaces/index.js';
import { EventSourcingFeature } from './event-sourcing-feature.js';
import { isStaticProvider, providerClassOf } from './providers.js';

/**
 * What the registrar registers, or the issues that keep it from doing so.
 * @internal Not exported from the package.
 */
export interface RegistrationPlan {
	/** The events of `forRoot` and of every `forFeature`, each class once. */
	readonly events: Type<IEvent>[];
	readonly serializers: ProviderWrapper<IEventSerializer>[];
	readonly commands: ProviderWrapper<ICommandHandler>[];
	readonly queries: ProviderWrapper<IQueryHandler>[];
	readonly publishers: ProviderWrapper<IEventPublisher>[];
	readonly subscribers: ProviderWrapper<IEventSubscriber>[];
	/** Every problem found; the registrar registers nothing unless this is empty. */
	readonly issues: EventSourcingConfigurationIssue[];
}

/**
 * How the events without an `@EventSerializer()` of their own are serialized.
 * @internal Not exported from the package.
 */
export interface SerializationPlanOptions {
	/** `defaultEventSerializer` of the options: `JsonEventSerializer` when `undefined`. */
	readonly defaultSerializer?: unknown;
	/** Finds class-transformer decorators; `undefined` without class-transformer, which checks nothing. */
	readonly classTransformerDecoratorsOf?: ClassTransformerDecoratorsOf;
}

const isSerializerFactory = (value: unknown): value is EventSerializerFactory =>
	(typeof value === 'object' || typeof value === 'function') &&
	value !== null &&
	typeof (value as { for?: unknown }).for === 'function';

const nameOfClass = (value: unknown): string =>
	typeof value === 'function' ? value.name || 'an anonymous class' : describeValue(value);

const scopeOf = (wrapper: ProviderWrapper): string => {
	if (wrapper.isTransient) {
		return 'is transient';
	}
	return wrapper.scope === Scope.REQUEST ? 'is request-scoped' : 'depends on a request-scoped provider';
};

/**
 * Plans the registration of an application from its providers, as Nest's discovery lists them, and the events of
 * `forRoot`: it finds the `forFeature` events, the handlers, subscribers, publishers and serializers by the metadata of
 * their class (read from the instance, so that factory and value providers are found too), and checks the whole
 * configuration at once (ADR 0001 §3). Registering one class more than once, in several modules or `events` options,
 * is deduplicated: the first one counts.
 *
 * @internal Not exported from the package.
 */
export const planRegistration = (
	providers: readonly ProviderWrapper[],
	rootEvents: unknown,
	{ defaultSerializer, classTransformerDecoratorsOf }: SerializationPlanOptions = {},
): RegistrationPlan => {
	const issues: EventSourcingConfigurationIssue[] = [];
	const issue = (kind: EventSourcingConfigurationIssue['kind'], message: string) => issues.push({ kind, message });

	// Events: those of forRoot, then those of every forFeature
	const events: Type<IEvent>[] = [];
	const listed = new Set<Function>();
	const eventsByName = new Map<string, Function>();
	const addEvents = (list: unknown, source: string) => {
		if (list === undefined || list === null) {
			return;
		}
		if (!Array.isArray(list)) {
			issue(
				'invalid-options',
				`The events of ${source} must be an array of event classes, got ${describeValue(list)}.`,
			);
			return;
		}
		for (const event of list) {
			if (typeof event !== 'function') {
				issue(
					'invalid-options',
					`The events of ${source} contain ${describeValue(event)}, which is not an event class.`,
				);
				continue;
			}
			if (listed.has(event)) {
				continue;
			}
			listed.add(event);
			const { name } = getEventMetadata(event as Type<IEvent>);
			if (!name) {
				issue(
					'missing-metadata',
					`The event ${nameOfClass(event)} in ${source} has no @Event() metadata: decorate it with @Event().`,
				);
				continue;
			}
			const other = eventsByName.get(name);
			if (other) {
				issue(
					'duplicate-event-name',
					`The events ${nameOfClass(other)} and ${nameOfClass(event)} share the event name "${name}": give one of them another name with @Event('...').`,
				);
				continue;
			}
			eventsByName.set(name, event);
			events.push(event as Type<IEvent>);
		}
	};

	const features = providers
		.map(({ instance }) => instance)
		.filter((instance): instance is EventSourcingFeature => instance instanceof EventSourcingFeature);
	addEvents(rootEvents, 'EventSourcingModule.forRoot()');
	for (const feature of features) {
		addEvents(feature.events, 'EventSourcingModule.forFeature()');
		for (const serializer of feature.serializers) {
			if (typeof serializer !== 'function') {
				issue(
					'invalid-options',
					`The serializers of EventSourcingModule.forFeature() contain ${describeValue(serializer)}, which is not a class.`,
				);
			} else if (!Reflect.hasMetadata(EVENT_SERIALIZER_METADATA, serializer)) {
				issue(
					'missing-metadata',
					`The serializer ${nameOfClass(serializer)} in EventSourcingModule.forFeature() has no @EventSerializer() metadata: decorate it with @EventSerializer(TheEvent).`,
				);
			}
		}
	}

	const unregistered = (event: Function, what: string) =>
		issue(
			'unregistered-event',
			`${what} is for the event ${nameOfClass(event)}, which is not registered: add it to the events of EventSourcingModule.forRoot() or forFeature().`,
		);
	const notStatic = (wrapper: ProviderWrapper, what: string) =>
		issue(
			'non-static-provider',
			`${what} ${scopeOf(wrapper)}. Subscribers, publishers and serializers live as long as the application: provide it with the default (singleton) scope, and resolve request-scoped dependencies per call with ModuleRef.resolve().`,
		);

	const serializers: ProviderWrapper<IEventSerializer>[] = [];
	const commands: ProviderWrapper<ICommandHandler>[] = [];
	const queries: ProviderWrapper<IQueryHandler>[] = [];
	const publishers: ProviderWrapper<IEventPublisher>[] = [];
	const subscribers: ProviderWrapper<IEventSubscriber>[] = [];
	// The classes registered so far per role, to deduplicate a class provided in several modules
	const seen = {
		serializers: new Set<Function>(),
		commands: new Set<Function>(),
		queries: new Set<Function>(),
		publishers: new Set<Function>(),
		subscribers: new Set<Function>(),
	};
	const serializerByEvent = new Map<Function, Function>();
	// The events that a serializer class names, also one with an issue, so that it isn't reported as on the default too
	const eventsWithSerializer = new Set<Function>();
	const commandHandlerByCommand = new Map<Function, Function>();
	const queryHandlerByQuery = new Map<Function, Function>();

	for (const wrapper of providers) {
		const type = providerClassOf(wrapper);
		if (!type) {
			continue;
		}
		const isStatic = isStaticProvider(wrapper);

		if (Reflect.hasMetadata(COMMAND_HANDLER_METADATA, type) && !seen.commands.has(type)) {
			seen.commands.add(type);
			const { command } = getCommandHandlerMetadata(type as Type<ICommandHandler>);
			if (typeof command !== 'function') {
				issue(
					'missing-metadata',
					`The command handler ${nameOfClass(type)} names no command class: @CommandHandler(TheCommand).`,
				);
			} else if (commandHandlerByCommand.has(command)) {
				issue(
					'duplicate-command-handler',
					`${nameOfClass(commandHandlerByCommand.get(command))} and ${nameOfClass(type)} both handle the command ${nameOfClass(command)}: keep one handler per command.`,
				);
			} else {
				commandHandlerByCommand.set(command, type);
				commands.push(wrapper as ProviderWrapper<ICommandHandler>);
			}
		}

		if (Reflect.hasMetadata(QUERY_HANDLER_METADATA, type) && !seen.queries.has(type)) {
			seen.queries.add(type);
			const { query } = getQueryHandlerMetadata(type as Type<IQueryHandler>);
			if (typeof query !== 'function') {
				issue(
					'missing-metadata',
					`The query handler ${nameOfClass(type)} names no query class: @QueryHandler(TheQuery).`,
				);
			} else if (queryHandlerByQuery.has(query)) {
				issue(
					'duplicate-query-handler',
					`${nameOfClass(queryHandlerByQuery.get(query))} and ${nameOfClass(type)} both handle the query ${nameOfClass(query)}: keep one handler per query.`,
				);
			} else {
				queryHandlerByQuery.set(query, type);
				queries.push(wrapper as ProviderWrapper<IQueryHandler>);
			}
		}

		if (Reflect.hasMetadata(EVENT_SERIALIZER_METADATA, type) && !seen.serializers.has(type)) {
			seen.serializers.add(type);
			const { event } = getEventSerializerMetadata(type as Type<IEventSerializer>);
			if (typeof event === 'function') {
				eventsWithSerializer.add(event);
			}
			if (!isStatic) {
				notStatic(wrapper, `The event serializer ${nameOfClass(type)}`);
			} else if (typeof event !== 'function') {
				issue(
					'missing-metadata',
					`The event serializer ${nameOfClass(type)} names no event class: @EventSerializer(TheEvent).`,
				);
			} else if (!listed.has(event)) {
				unregistered(event, `The event serializer ${nameOfClass(type)}`);
			} else if (serializerByEvent.has(event)) {
				issue(
					'duplicate-event-serializer',
					`${nameOfClass(serializerByEvent.get(event))} and ${nameOfClass(type)} both serialize the event ${nameOfClass(event)}: keep one serializer per event.`,
				);
			} else {
				serializerByEvent.set(event, type);
				serializers.push(wrapper as ProviderWrapper<IEventSerializer>);
			}
		}

		if (Reflect.hasMetadata(EVENT_PUBLISHER_METADATA, type) && !seen.publishers.has(type)) {
			seen.publishers.add(type);
			if (!isStatic) {
				notStatic(wrapper, `The event publisher ${nameOfClass(type)}`);
			} else {
				publishers.push(wrapper as ProviderWrapper<IEventPublisher>);
			}
		}

		if (Reflect.hasMetadata(EVENT_SUBSCRIBER_METADATA, type) && !seen.subscribers.has(type)) {
			seen.subscribers.add(type);
			const { events: subscribed } = getEventSubscriberMetadata(type as Type<IEventSubscriber>);
			if (!isStatic) {
				notStatic(wrapper, `The event subscriber ${nameOfClass(type)}`);
			} else if (!Array.isArray(subscribed) || subscribed.length === 0) {
				issue(
					'missing-metadata',
					`The event subscriber ${nameOfClass(type)} names no events: @EventSubscriber(TheEvent, ...).`,
				);
			} else {
				let valid = true;
				for (const event of subscribed) {
					if (typeof event !== 'function') {
						valid = false;
						issue(
							'missing-metadata',
							`The event subscriber ${nameOfClass(type)} names ${describeValue(event)}, which is not an event class.`,
						);
					} else if (!listed.has(event)) {
						valid = false;
						unregistered(event, `The event subscriber ${nameOfClass(type)}`);
					}
				}
				if (valid) {
					subscribers.push(wrapper as ProviderWrapper<IEventSubscriber>);
				}
			}
		}
	}

	// The default serializer, and the class-transformer decorators it would ignore (ADR 0001 §3, §6)
	if (defaultSerializer !== undefined && !isSerializerFactory(defaultSerializer)) {
		issue(
			'invalid-options',
			`The defaultEventSerializer of EventSourcingModule.forRoot() must be an event serializer factory with a for() method, such as JsonEventSerializer or ClassTransformerEventSerializer, got ${describeValue(defaultSerializer)}.`,
		);
	} else if (classTransformerDecoratorsOf) {
		const factory = defaultSerializer ?? JsonEventSerializer;
		for (const event of events) {
			if (eventsWithSerializer.has(event)) {
				continue;
			}
			const decorators = classTransformerDecoratorsOf(event);
			if (decorators.length > 0 && factory.for(event) instanceof JsonEventSerializer) {
				issue(
					'class-transformer-decorators',
					`The event ${nameOfClass(event)} uses class-transformer decorators (${decorators.join(', ')}), which the default JsonEventSerializer ignores: set defaultEventSerializer: ClassTransformerEventSerializer (from '@ocoda/event-sourcing/class-transformer') in EventSourcingModule.forRoot(), or register an @EventSerializer() for the event.`,
				);
			}
		}
	}

	return { events, serializers, commands, queries, publishers, subscribers, issues };
};
