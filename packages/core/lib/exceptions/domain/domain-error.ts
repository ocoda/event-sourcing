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
		this.name = new.target.name;
	}
}
