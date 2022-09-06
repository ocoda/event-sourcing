import { ISnapshot, ISnapshotPayload, Snapshot, SnapshotHandler } from '@ocoda/event-sourcing';
import { Account, AccountId, AccountOwnerId } from './account.aggregate';

@Snapshot(Account, { name: 'account', interval: 5 })
export class AccountSnapshotHandler extends SnapshotHandler<Account> {
	serialize({ id, ownerIds, balance, openedOn, closedOn }: ISnapshot<Account>) {
		return {
			id: id.value,
			ownerIds: ownerIds.map(({ value }) => value),
			balance,
			openedOn: openedOn ? openedOn.toISOString() : undefined,
			closedOn: closedOn ? closedOn.toISOString() : undefined,
		};
	}
	deserialize({ id, ownerIds, balance, openedOn, closedOn }: ISnapshotPayload<Account>): ISnapshot<Account> {
		return {
			id: AccountId.from(id),
			ownerIds: ownerIds.map((id) => AccountOwnerId.from(id)),
			balance,
			openedOn: openedOn && new Date(openedOn),
			closedOn: closedOn && new Date(closedOn),
		};
	}
}
