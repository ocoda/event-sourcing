import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { CommandBus } from '../command-bus.js';
import { EVENT_SOURCING_OPTIONS } from '../constants.js';
import { EventBus } from '../event-bus.js';
import { EventMap } from '../event-map.js';
import { EventSourcingConfigurationException, EventSourcingNotReadyException } from '../exceptions/index.js';
import {
	CLASS_TRANSFORMER_DECORATORS,
	type ClassTransformerDecoratorsOf,
} from '../helpers/class-transformer-decorators.js';
import type { EventSourcingModuleOptions, ProviderWrapper } from '../interfaces/index.js';
import { QueryBus } from '../query-bus.js';
import { planRegistration } from './plan.js';
import { isInstantiated, isStaticProvider, providerName } from './providers.js';
import type { Registration } from './registration.js';

const logger = new Logger('EventSourcingModule');

/**
 * Registers the events, serializers, command and query handlers, publishers and subscribers of one application, once
 * (ADR 0001 §3). It finds them with Nest's discovery, in every module, and checks the whole configuration before it
 * registers anything, so a misconfiguration fails the bootstrap with one `EventSourcingConfigurationException` that
 * lists every problem.
 *
 * It runs in the module's `onModuleInit`, and on the first use of the `EventMap` (so of `appendEvents` and the reads)
 * and the buses: Nest gives every global module the same distance, so a provider of a user's `@Global()` module can
 * append events from its own `onModuleInit` before the module's hook ran. While Nest is still instantiating the
 * providers, that first use throws an `EventSourcingNotReadyException` instead, before any I/O: the handlers may not
 * exist yet.
 *
 * @internal Not exported from the package.
 */
@Injectable()
export class EventSourcingRegistrar implements Registration {
	private registered = false;
	private registering = false;

	constructor(
		private readonly discoveryService: DiscoveryService,
		private readonly moduleRef: ModuleRef,
		@Inject(EVENT_SOURCING_OPTIONS) private readonly options: EventSourcingModuleOptions,
		// Loaded by an async provider before this is created, so that registration can stay synchronous (ADR 0001 §6)
		@Optional()
		@Inject(CLASS_TRANSFORMER_DECORATORS)
		private readonly classTransformerDecoratorsOf?: ClassTransformerDecoratorsOf,
	) {}

	ensureRegistered(operation?: string): void {
		if (this.registered || this.registering) {
			return;
		}
		const providers = this.discoveryService.getProviders() as ProviderWrapper[];
		const pending = providers.filter((wrapper) => isStaticProvider(wrapper) && !isInstantiated(wrapper));
		if (pending.length > 0) {
			throw new EventSourcingNotReadyException({ operation, pendingProviders: pending.map(providerName) });
		}
		this.register(providers);
	}

	initialize(): void {
		if (this.registered || this.registering) {
			return;
		}
		this.register(this.discoveryService.getProviders() as ProviderWrapper[]);
	}

	private register(providers: ProviderWrapper[]): void {
		this.registering = true;
		try {
			const defaultSerializer = this.options?.defaultEventSerializer;
			const { classTransformerDecoratorsOf } = this;
			const plan = planRegistration(providers, this.options?.events, {
				defaultSerializer,
				classTransformerDecoratorsOf,
			});
			if (plan.issues.length > 0) {
				throw new EventSourcingConfigurationException({ issues: plan.issues });
			}

			// The plan checked the event classes; the JSON serializers check the instances an event holds when it's appended
			this.moduleRef
				.get(EventMap)
				.registerSerializers(plan.events, plan.serializers, { defaultSerializer, classTransformerDecoratorsOf });
			this.moduleRef.get(CommandBus).register(plan.commands);
			this.moduleRef.get(QueryBus).register(plan.queries);
			const eventBus = this.moduleRef.get(EventBus);
			eventBus.registerPublishers(plan.publishers);
			eventBus.registerSubscribers(plan.subscribers);

			this.registered = true;
			logger.debug(
				`Registered ${plan.events.length} event(s), ${plan.serializers.length} serializer(s), ${plan.commands.length} command handler(s), ${plan.queries.length} query handler(s), ${plan.publishers.length} publisher(s) and ${plan.subscribers.length} subscriber(s)`,
			);
		} finally {
			this.registering = false;
		}
	}
}
