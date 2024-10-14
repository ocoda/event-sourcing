import { monotonicFactory, ulid } from 'ulidx';
import { InvalidIdException } from '../exceptions';
import { ULID } from './ulid';

export class EventId extends ULID {
	public static generate(timeSeed?: number): ULID {
		const value = ulid(timeSeed);
		return new EventId(value);
	}

	public static from(id: string): ULID {
		if (!id) {
			throw InvalidIdException.becauseEmpty();
		}
		return new EventId(id);
	}

	static factory(): (seedTime?: number) => EventId {
		const generator = monotonicFactory();
		return (seedTime?: number) => new EventId(generator(seedTime));
	}
}
