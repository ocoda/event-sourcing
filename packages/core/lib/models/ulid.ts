import { decodeTime, monotonicFactory, ulid } from 'ulidx';
import { InvalidIdException } from '../exceptions';
import { Id } from './id';

export const ulidFactory = () => {};

export class ULID extends Id {
	protected constructor(id: string) {
		const format = /^[0-9a-z]{26}$/gi;
		if (!format.test(id)) {
			throw InvalidIdException.becauseInvalid(id);
		}
		super(id);
	}

	public static generate(timeSeed?: number): ULID {
		const value = ulid(timeSeed);
		return new ULID(value);
	}

	public static from(id: string): ULID {
		if (!id) {
			throw InvalidIdException.becauseEmpty();
		}
		return new ULID(id);
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

	static factory(): (seedTime?: number) => ULID {
		const generator = monotonicFactory();
		return (seedTime?: number) => new ULID(generator(seedTime));
	}
}
