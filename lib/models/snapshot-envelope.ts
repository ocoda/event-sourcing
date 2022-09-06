import { randomUUID } from 'crypto';
import { Id } from './id';
import { ISnapshotPayload, SnapshotEnvelopeMetadata } from '../interfaces';
import { Aggregate } from './aggregate';

export class SnapshotEnvelope<A extends Aggregate = Aggregate> {
  public readonly snapshotId: string;
  public readonly snapshotName: string;
  readonly payload: ISnapshotPayload<A>;
  readonly metadata: SnapshotEnvelopeMetadata;

  private constructor(
    aggregateId: string,
    sequence: number,
    snapshotName: string,
    payload: ISnapshotPayload<A>,
  ) {
    this.snapshotId = randomUUID();
    this.snapshotName = snapshotName;
    this.payload = payload;
    this.metadata = { aggregateId, sequence, registeredOn: Date.now() };
  }

  static new<A extends Aggregate>(
    aggregateId: Id,
    sequence: number,
    snapshotName: string,
    payload: ISnapshotPayload<A>,
  ): SnapshotEnvelope<A> {
    return new SnapshotEnvelope(
      aggregateId.value,
      sequence,
      snapshotName,
      payload,
    );
  }
}
