import { Aggregate } from "../aggregate";
import { IQuery } from '../interfaces';
import { QUERY_HANDLER_METADATA, QUERY_METADATA, SNAPSHOT_METADATA } from './constants';
import { QueryHandler } from './query-handler.decorator';
import { Snapshot } from "./snapshot.decorator";

describe('@Snapshot', () => {
  @Snapshot({ interval: 10 })
  class Foo extends Aggregate {}

  it('should specify after how many events a snapshot should be made', () => {
    const { interval } = Reflect.getMetadata(
      SNAPSHOT_METADATA,
      Foo,
    );

    expect(interval).toEqual(10);
  });
});
