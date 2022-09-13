import { Type } from '@nestjs/common';
import { ISnapshotPool } from '../interfaces';
import { Aggregate } from './aggregate';
import { Id } from './id';

export class SnapshotStream<A extends Aggregate = Aggregate> {
	public readonly collection = 'snapshots';

	private constructor(private _subject: Type<A>, private _id: Id, private _pool?: ISnapshotPool) {}

	get subject(): string {
		return `${this._subject.name.toLowerCase()}-snapshot`;
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
		snapshotPool?: ISnapshotPool,
	): SnapshotStream<A> {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);
		return new SnapshotStream<A>(cls, id, snapshotPool);
	}
}
