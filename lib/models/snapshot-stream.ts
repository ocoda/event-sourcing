import { Type } from '@nestjs/common';
import { AGGREGATE_METADATA } from '../decorators';
import { MissingAggregateMetadataException } from '../exceptions';
import { AggregateMetadata, ISnapshotCollection, ISnapshotPool } from '../interfaces';
import { AggregateRoot } from './aggregate-root';
import { Id } from './id';

export class SnapshotStream {
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

	get collection(): ISnapshotCollection {
		return this._pool ? `${this._pool}-snapshots` : 'snapshots';
	}

	static for<A extends AggregateRoot = AggregateRoot>(aggregate: A | Type<A>, id: Id, pool?: string): SnapshotStream {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);

		const metadata: AggregateMetadata = Reflect.getMetadata(AGGREGATE_METADATA, cls);
		if (!metadata) {
			throw new MissingAggregateMetadataException(cls);
		}

		return new SnapshotStream(metadata.streamName, id.value, pool);
	}
}
