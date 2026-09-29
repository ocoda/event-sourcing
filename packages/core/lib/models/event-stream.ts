import type { Type } from '@nestjs/common';
import { MissingAggregateMetadataException } from '../exceptions/index.js';
import { getAggregateMetadata } from '../helpers/index.js';
import type { AggregateRoot } from './aggregate-root.js';
import type { Id } from './id.js';

export class EventStream {
	private constructor(
		private _aggregate: string,
		private _aggregateId: string,
	) {}

	get aggregateId(): string {
		return this._aggregateId;
	}

	get streamId(): string {
		return `${this._aggregate}-${this._aggregateId}`;
	}

	static for<A extends AggregateRoot = AggregateRoot>(aggregate: A | Type<A>, id: Id): EventStream {
		const cls = aggregate instanceof Function ? aggregate : (aggregate.constructor as Type<A>);

		const { streamName } = getAggregateMetadata(cls);
		if (!streamName) {
			throw new MissingAggregateMetadataException(cls);
		}

		return new EventStream(streamName, id.value);
	}
}
