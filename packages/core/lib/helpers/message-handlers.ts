/**
 * The class of a command or query; `undefined` for `null`, `undefined` and null-prototype objects.
 * @internal Shared by the `CommandBus` and the `QueryBus`; not exported from the package.
 */
export const classOf = (message: unknown): Function | undefined =>
	message === null || message === undefined ? undefined : Object.getPrototypeOf(message)?.constructor;

/**
 * The handler bound to `type` or, if it has none, to its nearest parent class that has one. A subclass without a
 * handler of its own reaches the handler of its parent, as in 3.x, and a subclass with one reaches its own.
 * @internal Shared by the `CommandBus` and the `QueryBus`; not exported from the package.
 */
export const handlerFor = <THandler>(
	handlers: ReadonlyMap<Function, THandler>,
	type: Function | undefined,
): THandler | undefined => {
	// A class's prototype chain ends at Function.prototype, which is itself a function.
	let current = type;
	while (typeof current === 'function' && current !== Function.prototype) {
		const handler = handlers.get(current);
		if (handler) {
			return handler;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
};
