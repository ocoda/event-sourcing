import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';

import { AccountNotFoundException } from '../../domain/exceptions';
import { AccountId, AccountOwnerId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { AccountRepository } from '../repositories';

export class RemoveAccountOwnerCommand implements ICommand {
	constructor(
		public readonly accountId: string,
		public readonly accountOwnerId: string,
	) {}
}

@CommandHandler(RemoveAccountOwnerCommand)
export class RemoveAccountOwnerCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: RemoveAccountOwnerCommand): Promise<boolean> {
		const accountId = AccountId.from(command.accountId);
		const account = await this.accountRepository.getById(accountId);

		if (!account) {
			throw AccountNotFoundException.withId(accountId);
		}

		const accountOwnerId = AccountOwnerId.from(command.accountOwnerId);
		account.removeOwner(accountOwnerId);

		await this.accountRepository.save(account);

		return true;
	}
}
