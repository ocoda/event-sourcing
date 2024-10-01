import { Injectable } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { EventStore, EventStream } from '@ocoda/event-sourcing';
// biome-ignore lint/style/useImportType: DI
import { Account, AccountId, AccountSnapshotRepository } from '../../domain/models';

@Injectable()
export class AccountRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly accountSnapshotRepository: AccountSnapshotRepository,
	) {}

	async getById(accountId: AccountId) {
		const eventStream = EventStream.for<Account>(Account, accountId);

		const account = await this.accountSnapshotRepository.load(accountId, 'e2e');

		const eventCursor = this.eventStore.getEvents(eventStream, { pool: 'e2e', fromVersion: account.version + 1 });

		await account.loadFromHistory(eventCursor);

		return account;
	}

	async getByIds(accountIds: AccountId[]) {
		const accounts = await this.accountSnapshotRepository.loadMany(accountIds, 'e2e');

		for (const account of accounts) {
			const eventStream = EventStream.for<Account>(Account, account.id);
			const eventCursor = this.eventStore.getEvents(eventStream, { pool: 'e2e', fromVersion: account.version + 1 });
			await account.loadFromHistory(eventCursor);
		}

		return accounts;
	}

	async getAll(fromAccountId?: AccountId, limit?: number): Promise<Account[]> {
		const accounts = [];
		for await (const envelopes of this.accountSnapshotRepository.loadAll({
			fromId: fromAccountId,
			limit,
			pool: 'e2e',
		})) {
			for (const { metadata, payload } of envelopes) {
				const id = AccountId.from(metadata.aggregateId);
				const eventStream = EventStream.for<Account>(Account, id);
				const account = this.accountSnapshotRepository.deserialize(payload);

				const eventCursor = this.eventStore.getEvents(eventStream, { pool: 'e2e', fromVersion: metadata.version + 1 });
				await account.loadFromHistory(eventCursor);

				accounts.push(account);
			}
		}

		return accounts;
	}

	async save(account: Account): Promise<void> {
		const events = account.commit();
		const stream = EventStream.for<Account>(Account, account.id);

        await this.eventStore.appendEvents(stream, account.version, events, 'e2e');
        await this.accountSnapshotRepository.save(account.id, account, 'e2e');
	}
}
