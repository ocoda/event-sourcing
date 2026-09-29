import { DiscoveryModule, DiscoveryService, type ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
	EventSourcingConfigurationException,
	EventSourcingNotReadyException,
	type ProviderWrapper,
} from '@ocoda/event-sourcing';
import {
	isInstantiated,
	isStaticProvider,
	providerClassOf,
	providerName,
} from '../../../lib/registration/providers.js';
import { ScopedHandler } from '../../../lib/registration/scoped-handler.js';

const wrapper = (fields: Record<string, unknown>) => fields as unknown as ProviderWrapper;

describe('provider helpers', () => {
	class Handler {}

	it('reads the class of a provider from its instance, or from a class provider without one', () => {
		expect(providerClassOf(wrapper({ instance: new Handler(), metatype: () => undefined, inject: [] }))).toBe(Handler);
		expect(providerClassOf(wrapper({ instance: undefined, metatype: Handler }))).toBe(Handler);
		// A request-scoped factory: no instance, and the metatype is the factory
		expect(providerClassOf(wrapper({ instance: null, metatype: () => new Handler(), inject: [] }))).toBeUndefined();
		// A plain value
		expect(providerClassOf(wrapper({ instance: { plain: true }, metatype: null }))).toBeUndefined();
		// A proxy that throws on unknown properties
		const throwing = new Proxy(
			{},
			{
				get() {
					throw new Error('unknown property');
				},
			},
		);
		expect(providerClassOf(wrapper({ instance: throwing, metatype: null }))).toBeUndefined();
		expect(providerClassOf(undefined)).toBeUndefined();
	});

	it('tells static providers from request-scoped and transient ones', () => {
		expect(isStaticProvider(wrapper({}))).toBe(true);
		expect(isStaticProvider(wrapper({ isDependencyTreeStatic: () => true, isTransient: false }))).toBe(true);
		expect(isStaticProvider(wrapper({ isDependencyTreeStatic: () => false, isTransient: false }))).toBe(false);
		expect(isStaticProvider(wrapper({ isDependencyTreeStatic: () => true, isTransient: true }))).toBe(false);
	});

	it('tells whether Nest instantiated a provider from the host of its static instance', async () => {
		const app = await Test.createTestingModule({ imports: [DiscoveryModule], providers: [Handler] }).compile();
		const handler = app
			.get(DiscoveryService)
			.getProviders()
			.find(({ token }) => token === Handler) as ProviderWrapper;

		expect(isInstantiated(handler)).toBe(true);
		expect(isInstantiated(wrapper({}))).toBe(true);
		expect(isInstantiated(wrapper({ getInstanceByContextId: () => ({ instance: {}, isResolved: false }) }))).toBe(
			false,
		);
		expect(isInstantiated(wrapper({ getInstanceByContextId: () => ({ instance: {}, isPending: true }) }))).toBe(false);
		await app.close();
	});

	it('names a provider by its class, its name or its token', () => {
		expect(providerName(wrapper({ instance: new Handler() }))).toBe('Handler');
		expect(providerName(wrapper({ instance: null, name: 'SEED', token: 'SEED', inject: [] }))).toBe('SEED');
		expect(providerName(wrapper({ instance: null, token: Handler, inject: [], metatype: () => undefined }))).toBe(
			'Handler',
		);
		const token = Symbol('token');
		expect(providerName(wrapper({ instance: null, token, inject: [] }))).toBe('Symbol(token)');
		expect(providerName(undefined as never)).toBe('unknown');
	});
});

describe(ScopedHandler, () => {
	const moduleRef = () =>
		({
			resolve: vi.fn(async (_token: unknown, contextId: unknown) => ({ contextId })),
			registerRequestByContextId: vi.fn(),
		}) as unknown as ModuleRef & {
			resolve: ReturnType<typeof vi.fn>;
			registerRequestByContextId: ReturnType<typeof vi.fn>;
		};

	it('resolves in a new context for every call without a request', async () => {
		const ref = moduleRef();
		const handler = new ScopedHandler<{ contextId: unknown }>('HANDLER', ref);

		const [first, second] = [await handler.resolve(), await handler.resolve(null)];

		expect(first.contextId).not.toBe(second.contextId);
		expect(ref.registerRequestByContextId).not.toHaveBeenCalled();
		expect(ref.resolve).toHaveBeenCalledWith('HANDLER', first.contextId, { strict: false });
	});

	it('resolves in one context per request object, which it registers once', async () => {
		const ref = moduleRef();
		const handler = new ScopedHandler<{ contextId: unknown }>('HANDLER', ref);
		const request = { id: 'request' };
		const callable = () => undefined;

		const [first, second] = [await handler.resolve(request), await handler.resolve(request)];
		const [third, fourth] = [await handler.resolve(callable), await handler.resolve(callable)];

		expect(first.contextId).toBe(second.contextId);
		expect(third.contextId).toBe(fourth.contextId);
		expect(ref.registerRequestByContextId).toHaveBeenCalledTimes(2);
		expect(ref.registerRequestByContextId).toHaveBeenCalledWith(request, first.contextId);
	});

	it('registers a request that is not an object for every call', async () => {
		const ref = moduleRef();
		const handler = new ScopedHandler<{ contextId: unknown }>('HANDLER', ref);

		const [first, second] = [await handler.resolve('request-id'), await handler.resolve('request-id')];

		expect(first.contextId).not.toBe(second.contextId);
		expect(ref.registerRequestByContextId).toHaveBeenCalledWith('request-id', first.contextId);
	});
});

describe('module exceptions', () => {
	it('lists at most five pending providers in the message of EventSourcingNotReadyException', () => {
		const pendingProviders = ['A', 'B', 'C', 'D', 'E', 'F'];
		const error = new EventSourcingNotReadyException({ operation: 'CommandBus.execute', pendingProviders });

		expect(error.message).toBe(
			'CommandBus.execute was used while Nest was instantiating the providers (still instantiating A, B, C, D, E, ...). The handlers are registered once every provider exists: move the call to onModuleInit or a later lifecycle hook.',
		);
		expect(error.pendingProviders).toEqual(pendingProviders);
		expect(Object.isFrozen(error.pendingProviders)).toBe(true);
		expect(new EventSourcingNotReadyException().message).toMatch(/^The event sourcing module was used/);
	});

	it('keeps a frozen copy of the issues of EventSourcingConfigurationException', () => {
		const issues = [
			{ kind: 'invalid-options', message: 'first' },
			{ kind: 'missing-metadata', message: 'second' },
		] as const;
		const error = new EventSourcingConfigurationException({ issues });

		expect(error.issues).toEqual(issues);
		expect(error.issues).not.toBe(issues);
		expect(Object.isFrozen(error.issues)).toBe(true);
		expect(error.message).toBe(
			'Invalid EventSourcingModule configuration (2 issues)\n- [invalid-options] first\n- [missing-metadata] second',
		);
		expect(new EventSourcingConfigurationException({ issues: 'nope' as never }).issues).toEqual([]);
	});
});
