import { Type } from '@nestjs/common';
import { IEventPool } from '../interfaces';
import { Aggregate } from './aggregate';
import { Id } from './id';

/**
 * @class EventStream
 * @description EventStream is a class that represents a stream of events for a given aggregate.
 * @example
 * const stream = EventStream.for(Aggregate, Id);
 * console.log(stream.name); // 'aggregate-1234'
 * console.log(stream.subject); // 'aggregate'
 * console.log(stream.pool); // 'default'
 * console.log(stream.collection); // 'events'
 */
export class EventStream<A extends Aggregate = Aggregate> {
	public readonly collection = 'events';

	private constructor(
		private _subject: Type<A>, 
		private _id: Id, 
		private _pool: IEventPool = 'default',
	) {}

	get subject(): string {
		return this._subject.name.toLowerCase();
	}

	get name(): string {
		return `${this.subject}-${this._id.value}`;
	}

	get pool(): string | undefined {
		return this._pool;
	}

	static for<A extends Aggregate<any> = Aggregate<any>>(
		aggregate: A | Type<A>,
		id: Id,
		eventPool?: IEventPool,
	): EventStream<A> {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);
		return new EventStream<A>(cls, id, eventPool);
	}
}
