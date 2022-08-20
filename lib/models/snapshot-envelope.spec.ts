import { IEvent, ISnapshot } from '../interfaces';
import { Id } from './id';
import { SnapshotEnvelope } from './snapshot-envelope';

describe(SnapshotEnvelope, () => {
  const now = new Date();

  class FooId extends Id {}
  interface FooSnapshot extends ISnapshot {
    bar: string;
  }

  beforeAll(() =>
    jest.spyOn(global.Date, 'now').mockImplementationOnce(() => now.valueOf()),
  );

  it('should create a snapshot-envelope', () => {
    const fooId = FooId.generate();
    const fooSnapshot: FooSnapshot = { bar: 'bar' };

    const envelope = SnapshotEnvelope.new(fooId, 1, fooSnapshot);

    expect(envelope.snapshotId).toBeDefined();
    expect(envelope.payload).toEqual({ bar: 'bar' });
    expect(envelope.metadata.aggregateId).toEqual(fooId.value);
    expect(envelope.metadata.sequence).toBe(1);
    expect(envelope.metadata.registeredOn).toEqual(now.valueOf());
  });
});
