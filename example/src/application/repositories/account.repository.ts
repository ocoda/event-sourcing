import { Injectable } from '@nestjs/common';
import { EventStore, EventStream } from '@ocoda/event-sourcing';
import { Account, AccountId, AccountSnapshotHandler } from '../../domain/models';
import { AccountNotFoundException } from './exceptions/account-not-found.exception';

@Injectable()
export class AccountRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly accountSnapshotHandler: AccountSnapshotHandler,
	) {}

	async getById(accountId: AccountId): Promise<Account> {
		const eventStream = EventStream.for<Account>(Account, accountId);

		const account = await this.accountSnapshotHandler.load(accountId);

		const eventCursor = this.eventStore.getEvents(eventStream, {
			fromVersion: account.version + 1,
		});

		await account.loadFromHistory(eventCursor);

		if (account.version < 1) {
			throw new AccountNotFoundException(accountId.value);
		}

		return account;
	}

	async getAll(fromAccountId?: AccountId, limit?: number): Promise<Account[]> {
		const accounts = [];
		for await (const snapshots of this.accountSnapshotHandler.loadMany({
			fromId: fromAccountId,
			limit,
		})) {
			for (const snapshot of snapshots) {
				const eventStream = EventStream.for<Account>(Account, snapshot.id);
				const eventCursor = this.eventStore.getEvents(eventStream, {
					fromVersion: snapshot.version + 1,
				});
				const account = await snapshot.loadFromHistory(eventCursor);
				accounts.push(account);
			}
		}

		return accounts;
	}

	async save(account: Account): Promise<void> {
		const events = account.commit();
		const stream = EventStream.for<Account>(Account, account.id);

		await Promise.all([
			this.accountSnapshotHandler.save(account.id, account),
			this.eventStore.appendEvents(stream, account.version, events),
		]);
	}
}
