/**
 * Makes the static factories of an id class keep the class they are read from, also when they are passed around
 * detached, as in `values.map(AccountId.from)`: reading `AccountId.from` returns the method bound to `AccountId`, so it
 * creates an `AccountId`, like `AccountId.from(value)` does. The bound function is created once per class.
 *
 * Each name must be a static method the class declares itself. A subclass can still declare a static method of the
 * same name, or assign one, which then replaces the bound factory for that subclass.
 *
 * Internal: not exported from the package.
 */
export const bindStaticFactories = (cls: Function, names: readonly string[]): void => {
	for (const name of names) {
		const method: unknown = Object.getOwnPropertyDescriptor(cls, name)?.value;
		if (typeof method !== 'function') {
			throw new TypeError(`${cls.name} declares no static method ${name}`);
		}

		const bound = new WeakMap<Function, Function>();
		Object.defineProperty(cls, name, {
			configurable: true,
			enumerable: false,
			get(this: unknown) {
				if (typeof this !== 'function') {
					return method;
				}
				let factory = bound.get(this);
				if (!factory) {
					// The arrow function keeps the class as `this`; the computed key names it after the method
					factory = { [name]: (...args: unknown[]) => method.apply(this, args) }[name];
					bound.set(this, factory);
				}
				return factory;
			},
			set(this: unknown, value: unknown) {
				Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: false });
			},
		});
	}
};
