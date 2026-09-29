import { randomUUID } from 'node:crypto';
import { InvalidIdException } from '../exceptions/index.js';
import { bindStaticFactories } from './bind-static-factories.js';
import { Id } from './id.js';

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A UUID. `AccountId.generate()` on `class AccountId extends UUID {}` returns a new random (v4) `AccountId`.
 */
export class UUID extends Id {
	protected constructor(id: string = randomUUID()) {
		if (typeof id !== 'string' || !UUID_FORMAT.test(id)) {
			throw new InvalidIdException({ value: id, idType: new.target.name });
		}
		super(id);
	}

	/**
	 * Creates a new random (v4) id of this class.
	 */
	public static generate<T extends typeof UUID = typeof UUID>(this: T): T['prototype'] {
		return new (this as unknown as new () => T['prototype'])();
	}

	/**
	 * Creates an id of this class from an existing UUID, in either case.
	 * @throws InvalidIdException when the value is empty or not a UUID
	 */
	public static override from<T extends typeof Id = typeof UUID>(this: T, id: string): T['prototype'] {
		return super.from(id);
	}

	get value(): string {
		return this.props.value;
	}
}

bindStaticFactories(UUID, ['from', 'generate']);
