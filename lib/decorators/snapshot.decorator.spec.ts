import { Aggregate } from '../models';
import { SNAPSHOT_METADATA } from './constants';
import { Snapshot } from './snapshot.decorator';

describe('@Snapshot', () => {
  @Snapshot({ interval: 10 })
  class Foo extends Aggregate {}

  it('should specify after how many events a snapshot should be made', () => {
    const { interval } = Reflect.getMetadata(SNAPSHOT_METADATA, Foo);

    expect(interval).toEqual(10);
  });
});
