import { Injectable } from '@nestjs/common';
import { EventStore, EventStream, EventMap } from '@ocoda/event-sourcing';
import { Account, AccountId, AccountSnapshotHandler } from '../../domain/models';

@Injectable()
export class AccountRepository {
	constructor(
		private readonly eventMap: EventMap,
		private readonly eventStore: EventStore,
		private readonly accountSnapshotHandler: AccountSnapshotHandler,
	) {}

	async getById(accountId: AccountId) {
		const account = new Account();
		const eventStream = EventStream.for<Account>(Account, accountId);

		await this.accountSnapshotHandler.hydrate(accountId, account);

		const eventEnvelopes = await this.eventStore.getEvents(eventStream, account.version + 1);

		let events = eventEnvelopes.map(({ eventName, payload }) => {
			const eventSerializer = this.eventMap.getSerializer(eventName);
			return eventSerializer.deserialize(payload);
		});

		account.loadFromHistory(events);

		return account;
	}

	async save(account: Account): Promise<void> {
		const events = account.commit();

		const envelopes = this.eventMap.createEnvelopes(account.id, account.version, events);

		await Promise.all([
			this.accountSnapshotHandler.save(account.id, account),
			this.eventStore.appendEvents(EventStream.for<Account>(Account, account.id), ...envelopes),
		]);
	}
}
