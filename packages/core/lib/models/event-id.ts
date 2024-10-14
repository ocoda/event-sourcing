import { monotonicFactory, ulid } from 'ulidx';
import { InvalidIdException } from '../exceptions';
import { ULID } from './ulid';

/**
 * Represents an event identifier.
 * @description An event identifier is a unique identifier for an event, which also contains a timestamp.
 */
export class EventId extends ULID {
	public static generate(dateSeed?: Date): ULID {
		const value = ulid(dateSeed?.getTime());
		return new EventId(value);
	}

	public static from(id: string): ULID {
		if (!id) {
			throw InvalidIdException.becauseEmpty();
		}
		return new EventId(id);
	}

	static factory(): (dateSeed?: Date) => EventId {
		const generator = monotonicFactory();
		return (dateSeed?: Date) => new EventId(generator(dateSeed?.getTime()));
	}
}
