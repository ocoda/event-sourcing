import type { Id } from '../../models/index.js';

/**
 * The base class for your own domain errors, optionally tied to the id of the aggregate they concern.
 *
 * It has no `code`, so existing subclasses keep compiling. `name` defaults to the subclass's class name; declare it as
 * a literal (`override readonly name = 'AccountClosedException'`) if your build minifies class names. Pass the
 * underlying error as `cause` in the options.
 */
export abstract class DomainException extends Error {
	protected constructor(
		message: string,
		public id?: Id,
		options?: ErrorOptions,
	) {
		super(message, options);
		// Only when the subclass didn't set a name of its own, e.g. with a getter or on its prototype, which can't be
		// assigned to. Not enumerable, like the inherited `Error` name, so the error serializes as it did in 3.x.
		if (this.name === Error.prototype.name) {
			Object.defineProperty(this, 'name', { value: new.target.name, writable: true, configurable: true });
		}
	}
}
