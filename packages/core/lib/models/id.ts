import { InvalidIdException } from '../exceptions/index.js';
import { bindStaticFactories } from './bind-static-factories.js';
import { ValueObject } from './value-object.js';

interface Props {
	value: string;
}

/**
 * The base class of identifiers. Extend `UUID` or `ULID` for generated ids, or `Id` for ids of your own format:
 * `class AccountId extends UUID {}`.
 *
 * The static factories create an instance of the class they are called on (`AccountId.from(value)` returns an
 * `AccountId`), also when they are passed around detached (`values.map(AccountId.from)`). Ids of different classes
 * are never equal, even with the same value.
 */
export class Id extends ValueObject<Props> {
	protected constructor(id: string) {
		super({ value: id });
	}

	/**
	 * Creates an id of this class from an existing value.
	 * @throws InvalidIdException when the value is empty, or doesn't have the format of the class
	 */
	public static from<T extends typeof Id = typeof Id>(this: T, id: string): T['prototype'] {
		if (!id) {
			throw new InvalidIdException({ value: id, idType: this.name });
		}
		return new (this as unknown as new (id: string) => T['prototype'])(id);
	}

	get value(): string {
		return this.props.value;
	}
}

bindStaticFactories(Id, ['from']);
