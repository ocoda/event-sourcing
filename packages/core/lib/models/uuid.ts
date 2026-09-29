import { randomUUID } from 'node:crypto';
import { InvalidIdException } from '../exceptions/index.js';
import { Id } from './id.js';

export class UUID extends Id {
	protected constructor(id: string = randomUUID()) {
		const format = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/gi;
		if (!format.test(id)) {
			throw new InvalidIdException({ value: id, idType: new.target.name });
		}
		super(id);
	}

	public static generate(): UUID {
		return new UUID();
	}

	public static from(id: string): UUID {
		if (!id) {
			throw new InvalidIdException({ value: id, idType: this.name });
		}
		return new UUID(id);
	}

	get value(): string {
		return this.props.value;
	}
}
