import { randomUUID } from 'crypto';
import { Id } from './id';
import { SnapshotEnvelopeMetadata } from '../interfaces';

export class SnapshotEnvelope {
  public readonly snapshotId: string;
  readonly payload: unknown;
  readonly metadata: SnapshotEnvelopeMetadata;

  private constructor(aggregateId: string, sequence: number, payload: unknown) {
    this.snapshotId = randomUUID();
    this.payload = payload;
    this.metadata = { aggregateId, sequence, registeredOn: Date.now() };
  }

  static new(
    aggregateId: Id,
    sequence: number,
    payload: unknown,
  ): SnapshotEnvelope {
    return new SnapshotEnvelope(aggregateId.value, sequence, payload);
  }
}
