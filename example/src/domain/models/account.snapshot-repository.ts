import { type ISnapshot, Snapshot, SnapshotRepository } from '@ocoda/event-sourcing';
import { Account, AccountId, AccountOwnerId } from './account.aggregate';

@Snapshot(Account, { name: 'account', interval: 5 })
export class AccountSnapshotRepository extends SnapshotRepository<Account> {
	serialize({ id, ownerIds, balance, openedOn, closedOn }: Account): ISnapshot<Account> {
		return {
			id: id.value,
			ownerIds: ownerIds.map(({ value }) => value),
			balance,
			openedOn: openedOn ? openedOn.toISOString() : undefined,
			closedOn: closedOn ? closedOn.toISOString() : undefined,
		};
	}
	deserialize({ id, ownerIds, balance, openedOn, closedOn }: ISnapshot<Account>): Account {
		const account = new Account();
		account.id = AccountId.from(id);
		account.ownerIds = ownerIds.map(AccountOwnerId.from);
		account.balance = balance;
		account.openedOn = openedOn && new Date(openedOn);
		account.closedOn = closedOn && new Date(closedOn);

		return account;
	}
}
