import { Type } from '@nestjs/common';
import { Aggregate } from '../models';
import { SNAPSHOT_SERIALIZER_METADATA } from './constants';
import { SnapshotSerializer } from './snapshot-serializer.decorator';

describe('@SnapshotSerializer', () => {
  class Account extends Aggregate {}

  @SnapshotSerializer(Account)
  class AccountCreatedEventSerializer {}

  it('should specify which aggregate the snapshot-serializer serializes', () => {
    const aggregate: Type<Aggregate> = Reflect.getMetadata(
      SNAPSHOT_SERIALIZER_METADATA,
      AccountCreatedEventSerializer,
    );
    expect(aggregate).toEqual(Account);
  });
});
