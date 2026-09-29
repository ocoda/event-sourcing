import type { InjectionToken } from '@nestjs/common';
import { type ContextId, ContextIdFactory, type ModuleRef } from '@nestjs/core';

/**
 * Per application (its module's `ModuleRef`), the DI context of each request passed to `execute(message, { request })`,
 * so that every command and query executed for one request resolves the same request-scoped instances, as Nest does
 * for the controller of that request. Per application, because each one registers the request in its own container.
 */
const requestContexts = new WeakMap<ModuleRef, WeakMap<object, ContextId>>();

const isWeakKey = (value: unknown): value is object =>
	(typeof value === 'object' && value !== null) || typeof value === 'function';

/**
 * A command or query handler that is not a singleton: request-scoped, transient, or depending on a request-scoped
 * provider. The bus resolves it for every `execute` call (ADR 0001 §3).
 *
 * - With a request (`execute(message, { request })`), it is resolved in the DI context of that request, which gets the
 *   request as `REQUEST`: the context Nest created for it, if a request-scoped controller handles it, or else one the
 *   bus creates on first use and reuses for later calls with the same request.
 * - Without one, it is resolved in a new context, so every call gets a new instance and `REQUEST` is `undefined`.
 *
 * @internal Not exported from the package.
 */
export class ScopedHandler<THandler> {
	constructor(
		readonly token: InjectionToken,
		private readonly moduleRef: ModuleRef,
	) {}

	resolve(request?: unknown): Promise<THandler> {
		return this.moduleRef.resolve<unknown, THandler>(this.token, this.contextOf(request), { strict: false });
	}

	private contextOf(request: unknown): ContextId {
		if (request === undefined || request === null) {
			return ContextIdFactory.create();
		}
		const contexts = isWeakKey(request) ? this.contexts() : undefined;
		const known = contexts?.get(request as object);
		if (known) {
			return known;
		}
		const contextId = ContextIdFactory.getByRequest(request as Record<string | symbol, unknown>);
		this.moduleRef.registerRequestByContextId(request, contextId);
		contexts?.set(request as object, contextId);
		return contextId;
	}

	private contexts(): WeakMap<object, ContextId> {
		let contexts = requestContexts.get(this.moduleRef);
		if (!contexts) {
			contexts = new WeakMap();
			requestContexts.set(this.moduleRef, contexts);
		}
		return contexts;
	}
}
