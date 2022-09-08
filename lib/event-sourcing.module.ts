import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CommandBus } from './command-bus';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventPublisher } from './event-publisher';
import { createEventSourcingProviders, EventStoreProvider, SnapshotStoreProvider } from './event-sourcing.providers';
import { EventStore } from './event-store';
import { HandlersLoader } from './handlers.loader';
import { InMemoryEventStore } from './integration/event-store';
import { InMemorySnapshotStore } from './integration/snapshot-store';
import { EventSourcingModuleAsyncOptions, EventSourcingModuleOptions, EventSourcingOptionsFactory } from './interfaces';
import { QueryBus } from './query-bus';
import { SnapshotStore } from './snapshot-store';

@Module({})
export class EventSourcingModule {
	/**
	 * Register the module synchronously
	 */
	static forRoot(options: EventSourcingModuleOptions): DynamicModule {
		const providers = [
			...createEventSourcingProviders(options),
			EventMap,
			HandlersLoader,
			CommandBus,
			EventPublisher,
			QueryBus,
			EventStoreProvider,
			SnapshotStoreProvider,
		];

		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule],
			providers,
			exports: providers,
		};
	}

	/**
	 * Register the module asynchronously
	 */
	static forRootAsync(options: EventSourcingModuleAsyncOptions): DynamicModule {
		const providers = [
			...this.createAsyncProviders(options),
			EventMap,
			HandlersLoader,
			CommandBus,
			EventPublisher,
			QueryBus,
			EventStoreProvider,
			SnapshotStoreProvider,
		];
		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule, ...(options?.imports || [])],
			providers: providers,
			exports: providers,
		};
	}

	private static createAsyncProviders(options: EventSourcingModuleAsyncOptions): Provider[] {
		if (options.useExisting || options.useFactory) {
			return [this.createAsyncOptionsProvider(options)];
		}
		return [
			this.createAsyncOptionsProvider(options),
			{
				provide: options.useClass,
				useClass: options.useClass,
			},
		];
	}

	private static createAsyncOptionsProvider(options: EventSourcingModuleAsyncOptions): Provider {
		if (options.useFactory) {
			return {
				provide: EVENT_SOURCING_OPTIONS,
				useFactory: options.useFactory,
				inject: options.inject || [],
			};
		}
		return {
			provide: EVENT_SOURCING_OPTIONS,
			useFactory: async (optionsFactory: EventSourcingOptionsFactory) =>
				await optionsFactory.createEventSourcingOptions(),
			inject: [options.useExisting || options.useClass],
		};
	}
}
