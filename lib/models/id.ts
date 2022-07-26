import { randomUUID } from 'crypto';
import { InvalidIdError } from '../exceptions';
import { ValueObject } from './value-object';

interface Props {
	value: string;
}

export class Id extends ValueObject<Props> {
	protected constructor(id: string = randomUUID()) {
		const format = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/gi;
		if (!format.test(id)) {
			throw InvalidIdError.becauseInvalid(id);
		}
		super({ value: id });
	}

	public static generate(): Id {
		return new Id();
	}

	public static from(id: string): Id {
		if (!id) {
			throw InvalidIdError.becauseEmpty();
		}
		return new Id(id);
	}

	get value(): string {
		return this.props.value;
	}
}
