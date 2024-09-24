import { Injectable } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { EventStore, EventStream } from '@ocoda/event-sourcing';
// biome-ignore lint/style/useImportType: DI
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

	async getByIds(accountIds: AccountId[]) {
		const accounts = await this.accountSnapshotHandler.loadMany(accountIds, 'e2e');

		for (const account of accounts) {
			const eventStream = EventStream.for<Account>(Account, account.id);
			const eventCursor = this.eventStore.getEvents(eventStream, { pool: 'e2e', fromVersion: account.version + 1 });
			await account.loadFromHistory(eventCursor);
		}

		return accounts;
	}

	async getAll(fromAccountId?: AccountId, limit?: number): Promise<Account[]> {
		const accounts = [];
		for await (const envelopes of this.accountSnapshotHandler.loadAll({
			fromId: fromAccountId,
			limit,
		})) {
			for (const { metadata, payload } of envelopes) {
				const id = AccountId.from(metadata.aggregateId);
				const eventStream = EventStream.for<Account>(Account, id);
				const account = this.accountSnapshotHandler.deserialize(payload);

				const eventCursor = this.eventStore.getEvents(eventStream, { fromVersion: metadata.version + 1 });
				await account.loadFromHistory(eventCursor);

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
