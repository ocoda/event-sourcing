import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { createEventSourcingProviders, EventStoreProvider, SnapshotStoreProvider } from './event-sourcing.providers';
import { HandlersLoader } from './handlers.loader';
import { EventSourcingModuleAsyncOptions, EventSourcingModuleOptions, EventSourcingOptionsFactory } from './interfaces';
import { QueryBus } from './query-bus';

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
			QueryBus,
			EventStoreProvider,
			SnapshotStoreProvider,
		];

		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule, EventEmitterModule.forRoot()],
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
			QueryBus,
			EventStoreProvider,
			SnapshotStoreProvider,
		];
		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule, EventEmitterModule.forRoot(), ...(options?.imports || [])],
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
