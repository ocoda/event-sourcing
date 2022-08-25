import { randomUUID } from 'crypto';
import { Id } from './id';
import { ISnapshot, SnapshotEnvelopeMetadata } from '../interfaces';
import { Aggregate } from './aggregate';

export class SnapshotEnvelope<A extends Aggregate> {
  public readonly snapshotId: string;
  readonly payload: ISnapshot<A>;
  readonly metadata: SnapshotEnvelopeMetadata;

  private constructor(
    aggregateId: string,
    sequence: number,
    payload: ISnapshot<A>,
  ) {
    this.snapshotId = randomUUID();
    this.payload = payload;
    this.metadata = { aggregateId, sequence, registeredOn: Date.now() };
  }

  static new<A extends Aggregate>(
    aggregateId: Id,
    sequence: number,
    payload: ISnapshot<A>,
  ): SnapshotEnvelope<A> {
    return new SnapshotEnvelope(aggregateId.value, sequence, payload);
  }
}
