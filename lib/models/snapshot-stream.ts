import { Type } from '@nestjs/common';
import { Aggregate } from './aggregate';
import { Id } from './id';

export class SnapshotStream<A extends Aggregate = Aggregate> {
	private constructor(private _subject: Type<A>, private _id: Id) {}

	get subject(): string {
		return `${this._subject.name.toLowerCase()}-snapshot`;
	}

	get name(): string {
		return `${this.subject}-${this._id.value}`;
	}

	static for<A extends Aggregate<any> = Aggregate<any>>(aggregate: A | Type<A>, id: Id): SnapshotStream<A> {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);
		return new SnapshotStream<A>(cls, id);
	}
}
