import { Type } from '@nestjs/common';
import { Aggregate } from './aggregate';
import { Id } from './id';

export class EventStream<A extends Aggregate = Aggregate> {
	private constructor(private _subject: Type<A>, private _id: Id) {}

	get subject(): string {
		return this._subject.name;
	}

	get name(): string {
		return `${this._subject.name}-${this._id.value}`;
	}

	static for<A extends Aggregate<any> = Aggregate<any>>(aggregate: A | Type<A>, id: Id): EventStream<A> {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);
		return new EventStream<A>(cls, id);
	}
}
