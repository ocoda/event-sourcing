import { Aggregate } from '../models';
import { SNAPSHOT_METADATA } from './constants';
import { Snapshot } from './snapshot.decorator';

describe('@Snapshot', () => {
  @Snapshot({ name: 'foo', interval: 10 })
  class Foo extends Aggregate {}

  it('should specify after how many events a snapshot should be made', () => {
    const { name, interval } = Reflect.getMetadata(SNAPSHOT_METADATA, Foo);

    expect(name).toEqual('foo');
    expect(interval).toEqual(10);
  });
});
