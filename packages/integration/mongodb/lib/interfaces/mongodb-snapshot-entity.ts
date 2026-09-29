import type { AggregateRoot, ISnapshot, SnapshotEnvelopeMetadata } from '@ocoda/event-sourcing';
import type { Document } from 'mongodb';

/**
 * A snapshot document. `latest` (`latest#<streamId>`) flags the latest snapshot of its stream; the other snapshots of
 * the stream have no `latest` field (3.x collections may still hold `latest: null`).
 */
export type MongoDBSnapshotEntity<A extends AggregateRoot> = {
	_id: string;
	streamId: string;
	payload: ISnapshot<A>;
	aggregateName: string;
	latest?: string | null;
} & Document &
	SnapshotEnvelopeMetadata;
