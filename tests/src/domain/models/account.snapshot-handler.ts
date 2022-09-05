import {
  ISnapshot,
  ISnapshotHandler,
  SnapshotEnvelope,
  SnapshotHandler,
  SnapshotStore,
  SnapshotStream,
} from '@ocoda/event-sourcing';
import { Account, AccountId, AccountOwnerId } from './account.aggregate';

interface AccountPayload {
  id: string;
  ownerIds: string[];
  balance: number;
  openedOn: number;
  closedOn: number;
}

@SnapshotHandler(Account)
export class AccountSnapshotHandler implements ISnapshotHandler {
  constructor(private readonly snapshotStore: SnapshotStore) {}

  async saveSnapshot(account: Account): Promise<void> {
    // TODO: make configurable
    if (account.version % 10 === 0) {
      const snapshotStream = SnapshotStream.for(Account, account.id);
      const payload = this.serialize(account.snapshot as ISnapshot<Account>);

      await this.snapshotStore.appendSnapshots(
        snapshotStream,
        SnapshotEnvelope.new(account.id, account.version, 'account', payload),
      );
    }
  }

  async loadFromSnapshot(account: Account): Promise<void> {
    const snapshotStream = SnapshotStream.for(Account, account.id);
    const snapshotEnvelope = await this.snapshotStore.getLastSnapshot(
      snapshotStream,
    );

    if (!snapshotEnvelope) {
      return;
    }

    const snapshot = this.deserialize(snapshotEnvelope.payload);
    account.loadFromSnapshot(snapshot);
  }

  serialize({ id, ownerIds, balance, openedOn, closedOn }: ISnapshot<Account>) {
    return {
      id: id.value,
      ownerIds: ownerIds.map(({ value }) => value),
      balance,
      openedOn: openedOn ? openedOn.toISOString() : undefined,
      closedOn: closedOn ? closedOn.toISOString() : undefined,
    };
  }
  deserialize({
    id,
    ownerIds,
    balance,
    openedOn,
    closedOn,
  }: AccountPayload): ISnapshot<Account> {
    return {
      id: AccountId.from(id),
      ownerIds: ownerIds.map((id) => AccountOwnerId.from(id)),
      balance,
      openedOn: openedOn && new Date(openedOn),
      closedOn: closedOn && new Date(closedOn),
    };
  }
}
