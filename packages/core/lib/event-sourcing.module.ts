import {
	ConfigurableModuleBuilder,
	type DynamicModule,
	Inject,
	Module,
	type OnModuleInit,
	Optional,
	type Type,
} from '@nestjs/common';
import { DiscoveryModule, ModuleRef } from '@nestjs/core';

import { EVENT_SOURCING_OPTIONS } from './constants.js';
import { CORE_EXPORTS, createCoreProviders } from './event-sourcing.providers.js';
import { EventSourcingConfigurationException } from './exceptions/index.js';
import type { InMemoryEventStoreConfig, InMemorySnapshotStoreConfig } from './integration/index.js';
import type {
	EventSourcingFeatureOptions,
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventSourcingOptionsFactory,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces/index.js';
import { EventSourcingFeature, EventSourcingFeatureModule } from './registration/event-sourcing-feature.js';
import { EVENT_SOURCING_REGISTRATION, type Registration } from './registration/registration.js';

const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<
	EventSourcingModuleOptions<EventStoreConfig, SnapshotStoreConfig>
>({ optionsInjectionToken: EVENT_SOURCING_OPTIONS })
	.setClassMethodName('forRoot')
	// The name of the method of a useClass or useExisting options factory, as in 3.x
	.setFactoryMethodName('createEventSourcingOptions')
	// One global module, which provides and exports the stores, the buses and the event map
	.setExtras({}, (definition) => ({
		...definition,
		global: true,
		imports: [...(definition.imports ?? []), DiscoveryModule],
		providers: [...(definition.providers ?? []), ...createCoreProviders()],
		exports: [...CORE_EXPORTS],
	}))
	.build();

const USE_VALUE_WARNING_CODE = 'OCODA_ES_FOR_ROOT_ASYNC_USE_VALUE';
let useValueWarned = false;

/**
 * Warns once per process that `forRootAsync({ useValue })` is deprecated.
 */
const warnUseValue = (): void => {
	if (useValueWarned) {
		return;
	}
	useValueWarned = true;
	process.emitWarning(
		'EventSourcingModule.forRootAsync({ useValue }) is deprecated and will be removed in 5.0. Use EventSourcingModule.forRoot(options) instead.',
		{ type: 'DeprecationWarning', code: USE_VALUE_WARNING_CODE },
	);
};

/**
 * Wires the library into a Nest application.
 *
 * - `forRoot(options)` or `forRootAsync(options)`, once, in the root module, registers one **global** module that
 *   provides the `EventStore`, the `SnapshotStore`, the `EventBus`, the `CommandBus`, the `QueryBus` and the
 *   `EventMap`. It creates and connects the stores while Nest instantiates the providers, so a wrong connection fails
 *   the bootstrap, and disconnects them when the application shuts down.
 * - `forFeature({ events, serializers, imports })`, in any feature module, registers the events of that module and
 *   provides its event serializers.
 *
 * The command and query handlers, event subscribers, publishers and serializers of every module are discovered and
 * registered in `onModuleInit`, or on the first use of the event store or a bus if a provider of another module uses
 * them earlier. The whole configuration is checked first: any problem fails the bootstrap with one
 * `EventSourcingConfigurationException` that lists them all (ADR 0001 §3).
 */
@Module({})
export class EventSourcingModule extends ConfigurableModuleClass implements OnModuleInit {
	constructor(@Optional() @Inject(EVENT_SOURCING_REGISTRATION) private readonly registration?: Registration) {
		super();
	}

	/**
	 * Registers the module with static options. The type arguments are the configs of the stores, which type their
	 * driver options: `forRoot<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>({ ... })`.
	 */
	static override forRoot<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {
		return super.forRoot(options ?? {});
	}

	/**
	 * Registers the module with options that another provider creates: `useFactory` (with `inject`), `useClass` or
	 * `useExisting` (an `EventSourcingOptionsFactory`), and `imports` for the modules that provide their dependencies.
	 *
	 * `useClass` reuses an instance of the class that one of the `imports` already provides; otherwise the module creates
	 * one, with its dependencies from `imports` and the global modules.
	 *
	 * @throws EventSourcingConfigurationException when none of `useFactory`, `useClass` and `useExisting` is given
	 */
	static override forRootAsync<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {
		type Options = EventSourcingModuleOptions<EventStoreConfig, SnapshotStoreConfig>;
		type Factory = Type<EventSourcingOptionsFactory<EventStoreConfig, SnapshotStoreConfig>>;
		const imports = options?.imports ?? [];

		if (options?.useValue) {
			warnUseValue();
			const value = options.useValue as Options;
			return super.forRootAsync({ imports, useFactory: () => value });
		}
		if (options?.useFactory) {
			return super.forRootAsync({
				imports,
				useFactory: options.useFactory as (...args: unknown[]) => Options | Promise<Options>,
				inject: options.inject ?? [],
			});
		}
		if (options?.useExisting) {
			return super.forRootAsync({ imports, useExisting: options.useExisting as Factory });
		}
		if (options?.useClass) {
			// Unlike the builder's useClass, an instance that one of the imports provides is reused: before 3.0.1 that was
			// the only way useClass worked, and that instance's dependencies need not be visible in this module
			const useClass = options.useClass as Factory;
			return super.forRootAsync({
				imports,
				useFactory: async (provided: InstanceType<Factory> | undefined, moduleRef: ModuleRef) => {
					const factory = provided ?? (await moduleRef.create(useClass));
					return await factory.createEventSourcingOptions();
				},
				inject: [{ token: useClass, optional: true }, ModuleRef],
			});
		}

		throw new EventSourcingConfigurationException({
			issues: [
				{
					kind: 'invalid-options',
					message:
						'EventSourcingModule.forRootAsync() needs one of "useFactory", "useClass" or "useExisting" to create the options.',
				},
			],
		});
	}

	/**
	 * Registers the events of a feature module, and provides the serializers of those events in it, with the
	 * dependencies they need from `imports`. The events belong to the applications that import the feature module, not
	 * to the process: two applications in one process can register different events.
	 */
	static forFeature(options: EventSourcingFeatureOptions = {}): DynamicModule {
		const serializers = [...(options?.serializers ?? [])];
		return {
			module: EventSourcingFeatureModule,
			imports: [...(options?.imports ?? [])],
			providers: [
				{ provide: EventSourcingFeature, useValue: new EventSourcingFeature(options?.events ?? [], serializers) },
				...serializers.filter((serializer) => typeof serializer === 'function'),
			],
		};
	}

	/**
	 * Registers the events, serializers, handlers, subscribers and publishers of the application, unless a provider of
	 * another module used the event store or a bus first, which registered them then.
	 *
	 * @throws EventSourcingConfigurationException listing every problem with the configuration
	 */
	onModuleInit(): void {
		this.registration?.initialize();
	}
}
