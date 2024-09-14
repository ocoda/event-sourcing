import { Type } from '@nestjs/common';
import { MissingAggregateMetadataException } from '../exceptions';
import { getAggregateMetadata } from '../helpers';
import { AggregateRoot } from './aggregate-root';
import { Id } from './id';

export class SnapshotStream {
	private constructor(
		private _aggregate: string,
		private _aggregateId: string,
	) {}

	get aggregate(): string {
		return this._aggregate;
	}

	get aggregateId(): string {
		return this._aggregateId;
	}

	get streamId(): string {
		return `${this._aggregate}-${this._aggregateId}`;
	}

	static for<A extends AggregateRoot = AggregateRoot>(aggregate: A | Type<A>, id: Id): SnapshotStream {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);

		const { streamName } = getAggregateMetadata(cls);
		if (!streamName) {
			throw new MissingAggregateMetadataException(cls);
		}

		return new SnapshotStream(streamName, id.value);
	}
}
