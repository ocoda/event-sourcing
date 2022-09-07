import { Injectable } from '@nestjs/common';
import { EventStore, EventStream } from '@ocoda/event-sourcing';
import { Account, AccountId, AccountSnapshotHandler } from '../../domain/models';

@Injectable()
export class AccountRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly accountSnapshotHandler: AccountSnapshotHandler,
	) {}

	async getById(accountId: AccountId) {
		const account = new Account();
		const eventStream = EventStream.for<Account>(Account, accountId);

		await this.accountSnapshotHandler.hydrate(accountId, account);

		const events = await this.eventStore.getEvents(eventStream, account.version + 1);

		account.loadFromHistory(events);

		return account;
	}

	async save(account: Account): Promise<void> {
		const events = account.commit();
		const stream = EventStream.for<Account>(Account, account.id);

		await Promise.all([
			this.accountSnapshotHandler.save(account.id, account),
			this.eventStore.appendEvents(account.id, account.version, stream, events),
		]);
	}
}
