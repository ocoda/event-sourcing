import { Type } from '@nestjs/common';
import { AGGREGATE_METADATA } from '../decorators';
import { MissingAggregateMetadataException } from '../exceptions';
import { AggregateMetadata, IEventCollection, ISnapshotPool } from '../interfaces';
import { AggregateRoot } from './aggregate-root';
import { Id } from './id';

export class EventStream {
	private constructor(
		private _aggregate: string,
		private _aggregateId: string,
		private readonly _pool?: ISnapshotPool,
	) {}

	get aggregateId(): string {
		return this._aggregateId;
	}

	get streamId(): string {
		return `${this._aggregate}-${this._aggregateId}`;
	}

	get collection(): IEventCollection {
		return this._pool ? `${this._pool}-events` : 'events';
	}

	static for<A extends AggregateRoot = AggregateRoot>(aggregate: A | Type<A>, id: Id, pool?: string): EventStream {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);

		const metadata: AggregateMetadata = Reflect.getMetadata(AGGREGATE_METADATA, cls);
		if (!metadata) {
			throw new MissingAggregateMetadataException(cls);
		}

		return new EventStream(metadata.streamName, id.value, pool);
	}
}
