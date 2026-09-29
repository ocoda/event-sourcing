import { decodeTime, monotonicFactory, ulid } from 'ulidx';
import { InvalidIdException } from '../exceptions/index.js';
import { bindStaticFactories } from './bind-static-factories.js';
import { Id } from './id.js';

export const ulidFactory = () => {};

/**
 * 26 characters of Crockford's base32 (the digits and the letters without I, L, O and U), in either case. The first
 * character is at most 7, so the time fits in 48 bits.
 */
const ULID_FORMAT = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

/**
 * A ULID: a 48-bit millisecond time and 80 random bits, in Crockford's base32. `AccountId.generate()` on
 * `class AccountId extends ULID {}` returns a new `AccountId`.
 */
export class ULID extends Id {
	protected constructor(id: string) {
		if (typeof id !== 'string' || !ULID_FORMAT.test(id)) {
			throw new InvalidIdException({ value: id, idType: new.target.name });
		}
		super(id);
	}

	/**
	 * Creates a new id of this class, for the current time or the time of `dateSeed`.
	 */
	public static generate<T extends typeof ULID = typeof ULID>(this: T, dateSeed?: Date): T['prototype'] {
		return new (this as unknown as new (id: string) => T['prototype'])(ulid(dateSeed?.getTime()));
	}

	/**
	 * Creates an id of this class from an existing ULID, in either case.
	 * @throws InvalidIdException when the value is empty or not a ULID: 26 characters of Crockford's base32 (without
	 * I, L, O and U), starting with 0–7
	 */
	public static override from<T extends typeof Id = typeof ULID>(this: T, id: string): T['prototype'] {
		return super.from(id);
	}

	get value(): string {
		return this.props.value;
	}

	get time(): number {
		return decodeTime(this.value);
	}

	get date(): Date {
		return new Date(this.time);
	}

	/**
	 * Returns a generator of ids of this class that increase monotonically, also within the same millisecond.
	 */
	static factory<T extends typeof ULID = typeof ULID>(this: T): (dateSeed?: Date) => T['prototype'] {
		const generator = monotonicFactory();
		const IdClass = this as unknown as new (id: string) => T['prototype'];
		return (dateSeed?: Date) => new IdClass(generator(dateSeed?.getTime()));
	}
}

bindStaticFactories(ULID, ['from', 'generate', 'factory']);
