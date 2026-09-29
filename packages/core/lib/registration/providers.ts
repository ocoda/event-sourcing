import { ContextIdFactory } from '@nestjs/core';
import type { ProviderWrapper } from '../interfaces/index.js';

/**
 * The class of a provider, to read its decorator metadata from: the constructor of its instance, so that providers
 * created with `useFactory` or `useValue` are found too, or the class of a class provider that has no instance yet.
 * `undefined` when neither is known, as for a request-scoped factory provider.
 * @internal Not exported from the package.
 */
export const providerClassOf = (wrapper: ProviderWrapper | undefined): Function | undefined => {
	const instance = wrapper?.instance;
	if (instance !== null && typeof instance === 'object') {
		let constructor: unknown;
		try {
			constructor = (instance as { constructor?: unknown }).constructor;
		} catch {
			// A proxy of another library that throws on unknown properties: not one of ours
			return undefined;
		}
		if (typeof constructor === 'function' && constructor !== Object) {
			return constructor;
		}
	}
	const metatype = wrapper?.metatype;
	const isFactory = wrapper?.inject !== undefined && wrapper?.inject !== null;
	return typeof metatype === 'function' && !isFactory ? metatype : undefined;
};

/**
 * Whether a provider has one instance for the whole application: not request-scoped, not transient, and not depending
 * on a request-scoped provider. A wrapper without the methods of Nest's `InstanceWrapper` (a test double) counts as
 * static.
 * @internal Not exported from the package.
 */
export const isStaticProvider = (wrapper: ProviderWrapper): boolean => {
	const isTreeStatic = typeof wrapper?.isDependencyTreeStatic === 'function' ? wrapper.isDependencyTreeStatic() : true;
	return isTreeStatic && !wrapper?.isTransient;
};

/**
 * A context other than Nest's static one. A static provider resolves to its one instance in every context, so asking
 * for its instance in this context returns the host of the static instance, with its `isResolved` flag, without
 * creating anything.
 */
const PROBE_CONTEXT = Object.freeze(ContextIdFactory.create());

/**
 * Whether Nest has instantiated a static provider. Until then its instance is missing (a factory provider) or a bare
 * prototype whose constructor hasn't run (a class provider).
 * @internal Not exported from the package.
 */
export const isInstantiated = (wrapper: ProviderWrapper): boolean => {
	if (typeof wrapper?.getInstanceByContextId !== 'function') {
		return true;
	}
	return wrapper.getInstanceByContextId(PROBE_CONTEXT)?.isResolved === true;
};

/**
 * A readable name of a provider, for messages.
 * @internal Not exported from the package.
 */
export const providerName = (wrapper: ProviderWrapper): string => {
	const type = providerClassOf(wrapper);
	if (type?.name) {
		return type.name;
	}
	const { name, token } = wrapper ?? {};
	if (typeof name === 'string' && name) {
		return name;
	}
	if (typeof token === 'function' && token.name) {
		return token.name;
	}
	return String(token ?? 'unknown');
};
