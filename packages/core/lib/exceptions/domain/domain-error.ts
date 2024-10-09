import type { Id } from '../../models';

export abstract class DomainException extends Error {
	protected constructor(
		message: string,
		public id?: Id,
	) {
		super(message);
	}
}
