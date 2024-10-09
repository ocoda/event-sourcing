import { InvalidIdException } from '../exceptions';
import { ValueObject } from './value-object';

interface Props {
	value: string;
}

export class Id extends ValueObject<Props> {
	protected constructor(id: string) {
		super({ value: id });
	}

	public static from(id: string): Id {
		if (!id) {
			throw InvalidIdException.becauseEmpty();
		}
		return new Id(id);
	}

	get value(): string {
		return this.props.value;
	}
}
