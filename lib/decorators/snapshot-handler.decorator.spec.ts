import { Type } from '@nestjs/common';
import { Aggregate } from '../models';
import { SNAPSHOT_HANDLER_METADATA } from './constants';
import { SnapshotHandler } from './snapshot-handler.decorator';

describe('@SnapshotHandler', () => {
  class Account extends Aggregate {}

  @SnapshotHandler(Account)
  class AccountSnapshotHandler {}

  it('should specify which aggregate the snapshot-handler handles', () => {
    const aggregate: Type<Aggregate> = Reflect.getMetadata(
      SNAPSHOT_HANDLER_METADATA,
      AccountSnapshotHandler,
    );
    expect(aggregate).toEqual(Account);
  });
});
