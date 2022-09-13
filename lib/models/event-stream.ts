import { Type } from '@nestjs/common';
import { AGGREGATE_METADATA } from '../decorators';
import { MissingAggregateMetadataException } from '../exceptions';
import { AggregateMetadata } from '../interfaces';
import { AggregateRoot } from './aggregate-root';
import { Id } from './id';

export class EventStream {
	private readonly _collection = 'events';

	private constructor(private _aggregate: string, private _id: string, private readonly _pool = 'default') {}

	get subject(): string {
		return `${this._aggregate}-${this._id}`;
	}

	get collection(): string {
		return this._collection;
	}

	get pool(): string {
		return this._pool;
	}

	static for<A extends AggregateRoot<any> = AggregateRoot<any>>(
		aggregate: A | Type<A>,
		id: Id,
		pool?: string,
	): EventStream {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);

		const metadata: AggregateMetadata = Reflect.getMetadata(AGGREGATE_METADATA, cls);
		if (!metadata) {
			throw new MissingAggregateMetadataException(cls);
		}

		return new EventStream(metadata.eventStream.toLowerCase(), id.value, pool);
	}
}
