import { Type } from '@nestjs/common';
import { Aggregate } from './aggregate';
import { Id } from './id';

export class EventStream<A extends Aggregate = Aggregate> {
	private constructor(private aggregate: Type<A>, private id: Id) {}

	get name(): string {
		return `${this.aggregate.name}-${this.id.value}`;
	}

	static for<A extends Aggregate<any> = Aggregate<any>>(aggregate: A | Type<A>, id: Id): EventStream<A> {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);
		return new EventStream<A>(cls, id);
	}
}
