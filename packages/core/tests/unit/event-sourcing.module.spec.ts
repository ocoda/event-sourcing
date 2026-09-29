import type { FactoryProvider, Provider, ValueProvider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
	CommandBus,
	EVENT_SOURCING_OPTIONS,
	Event,
	EventBus,
	EventMap,
	EventSerializer,
	EventSourcingConfigurationException,
	EventSourcingModule,
	EventStore,
	type IEvent,
	type IEventPayload,
	type IEventSerializer,
	QueryBus,
	SnapshotStore,
} from '@ocoda/event-sourcing';
import { EventSourcingFeature, EventSourcingFeatureModule } from '../../lib/registration/event-sourcing-feature.js';

@Event('module-spec-event')
class ModuleSpecEvent implements IEvent {}

@EventSerializer(ModuleSpecEvent)
class ModuleSpecEventSerializer implements IEventSerializer<ModuleSpecEvent> {
	serialize(): IEventPayload<ModuleSpecEvent> {
		return {} as IEventPayload<ModuleSpecEvent>;
	}
	deserialize(): ModuleSpecEvent {
		return new ModuleSpecEvent();
	}
}

const tokenOf = (provider: Provider) =>
	typeof provider === 'function' ? provider : (provider as { provide: unknown }).provide;
const firstProvider = (definition: { providers?: Provider[] }) => (definition.providers ?? [])[0] as ValueProvider;
const optionsProvider = (providers: Provider[] = []) =>
	providers.find((provider) => tokenOf(provider) === EVENT_SOURCING_OPTIONS) as
		| ValueProvider
		| FactoryProvider
		| undefined;

describe(EventSourcingModule, () => {
	describe('forRoot', () => {
		it('is one global module that provides and exports the stores, the buses, the event map and the options', () => {
			const events = [ModuleSpecEvent];
			const definition = EventSourcingModule.forRoot({ events });

			expect(definition.module).toBe(EventSourcingModule);
			expect(definition.global).toBe(true);
			expect(definition.imports).toEqual([DiscoveryModule]);
			// Only the options and the providers of the module: no second (core) module
			expect(definition.providers?.map(tokenOf)).toEqual(
				expect.arrayContaining([
					EVENT_SOURCING_OPTIONS,
					EventStore,
					SnapshotStore,
					EventBus,
					EventMap,
					CommandBus,
					QueryBus,
				]),
			);
			expect(definition.exports).toEqual(
				expect.arrayContaining([
					EVENT_SOURCING_OPTIONS,
					EventStore,
					SnapshotStore,
					EventBus,
					EventMap,
					CommandBus,
					QueryBus,
				]),
			);
			expect((optionsProvider(definition.providers) as ValueProvider).useValue).toEqual({ events });
		});

		it('takes no options as the defaults', () => {
			const definition = EventSourcingModule.forRoot(undefined as never);

			expect((optionsProvider(definition.providers) as ValueProvider).useValue).toEqual({});
		});
	});

	describe('forRootAsync', () => {
		it('creates the options with a factory, with its imports and injections', async () => {
			const factory = (value: string) => ({ events: [ModuleSpecEvent], label: value });
			const definition = EventSourcingModule.forRootAsync({
				imports: [DiscoveryModule],
				useFactory: factory,
				inject: ['LABEL'],
			});

			expect(definition.module).toBe(EventSourcingModule);
			expect(definition.global).toBe(true);
			expect(definition.imports).toEqual([DiscoveryModule, DiscoveryModule]);
			const provider = optionsProvider(definition.providers) as FactoryProvider;
			expect(provider.useFactory).toBe(factory);
			expect(provider.inject).toEqual(['LABEL']);
		});

		it('creates the options with an existing options factory', async () => {
			class OptionsFactory {
				createEventSourcingOptions() {
					return { events: [ModuleSpecEvent] };
				}
			}
			const definition = EventSourcingModule.forRootAsync({ useExisting: OptionsFactory });
			const provider = optionsProvider(definition.providers) as FactoryProvider;

			expect(provider.inject).toEqual([OptionsFactory]);
			await expect(provider.useFactory(new OptionsFactory())).resolves.toEqual({ events: [ModuleSpecEvent] });
			// The existing factory is not provided again
			expect(definition.providers?.map(tokenOf)).not.toContain(OptionsFactory);
		});

		it('creates the options with an options factory class, reusing an instance that is already provided', async () => {
			class OptionsFactory {
				createEventSourcingOptions() {
					return { events: [ModuleSpecEvent] };
				}
			}
			const definition = EventSourcingModule.forRootAsync({ useClass: OptionsFactory });
			const provider = optionsProvider(definition.providers) as FactoryProvider;
			const moduleRef = { create: vi.fn(async () => new OptionsFactory()) };

			expect(provider.inject?.[0]).toEqual({ token: OptionsFactory, optional: true });
			await expect(provider.useFactory(new OptionsFactory(), moduleRef)).resolves.toEqual({
				events: [ModuleSpecEvent],
			});
			expect(moduleRef.create).not.toHaveBeenCalled();
			await expect(provider.useFactory(undefined, moduleRef)).resolves.toEqual({ events: [ModuleSpecEvent] });
			expect(moduleRef.create).toHaveBeenCalledWith(OptionsFactory);
		});

		it('keeps useValue as a deprecated shim for forRoot, and warns once', async () => {
			vi.resetModules();
			const { EventSourcingModule: FreshModule } = await import('../../lib/event-sourcing.module.js');
			const warnings: Error[] = [];
			const onWarning = (warning: Error) => warnings.push(warning);
			process.on('warning', onWarning);
			try {
				const value = { events: [ModuleSpecEvent] };
				const definition = FreshModule.forRootAsync({ useValue: value });
				FreshModule.forRootAsync({ useValue: value });
				await new Promise((resolve) => setImmediate(resolve));

				const provider = optionsProvider(definition.providers) as FactoryProvider;
				expect(provider.useFactory()).toBe(value);
				expect(
					warnings.filter((warning) => (warning as { code?: string }).code === 'OCODA_ES_FOR_ROOT_ASYNC_USE_VALUE'),
				).toHaveLength(1);
			} finally {
				process.off('warning', onWarning);
			}
		});

		it('fails with a configuration issue without a source for the options', () => {
			const error = (() => {
				try {
					EventSourcingModule.forRootAsync({ imports: [DiscoveryModule] });
				} catch (error) {
					return error;
				}
			})();

			expect(error).toBeInstanceOf(EventSourcingConfigurationException);
			expect((error as EventSourcingConfigurationException).issues).toEqual([
				{ kind: 'invalid-options', message: expect.stringContaining('"useFactory", "useClass" or "useExisting"') },
			]);
		});
	});

	describe('forFeature', () => {
		it('provides the events and serializers of a feature module, with its imports, and registers nothing globally', () => {
			const definition = EventSourcingModule.forFeature({
				events: [ModuleSpecEvent],
				serializers: [ModuleSpecEventSerializer],
				imports: [DiscoveryModule],
			});

			expect(definition.module).toBe(EventSourcingFeatureModule);
			expect(definition.global).toBeUndefined();
			expect(definition.imports).toEqual([DiscoveryModule]);
			expect(definition.exports).toBeUndefined();
			const [feature, ...serializers] = definition.providers ?? [];
			expect((feature as ValueProvider).provide).toBe(EventSourcingFeature);
			expect((feature as ValueProvider).useValue).toEqual(
				new EventSourcingFeature([ModuleSpecEvent], [ModuleSpecEventSerializer]),
			);
			expect(serializers).toEqual([ModuleSpecEventSerializer]);
		});

		it('works without options', () => {
			const definition = EventSourcingModule.forFeature();

			expect(definition.imports).toEqual([]);
			expect(firstProvider(definition).useValue).toEqual(new EventSourcingFeature());
		});

		it('is a module of its own for every call', () => {
			const first = EventSourcingModule.forFeature({ events: [ModuleSpecEvent] });
			const second = EventSourcingModule.forFeature({ events: [ModuleSpecEvent] });

			expect(first).not.toBe(second);
			expect(firstProvider(first).useValue).not.toBe(firstProvider(second).useValue);
		});

		it('does not provide what is not a class, and keeps it for the bootstrap checks', () => {
			const definition = EventSourcingModule.forFeature({
				events: 'not-an-array' as never,
				serializers: [ModuleSpecEventSerializer, 'not-a-class' as never],
			});
			const [feature, ...serializers] = definition.providers ?? [];

			expect(serializers).toEqual([ModuleSpecEventSerializer]);
			expect((feature as ValueProvider<EventSourcingFeature>).useValue.events).toBe('not-an-array');
			expect((feature as ValueProvider<EventSourcingFeature>).useValue.serializers).toEqual([
				ModuleSpecEventSerializer,
				'not-a-class',
			]);
		});
	});
});
