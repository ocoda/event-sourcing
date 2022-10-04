import { CommandHandler, ICommand, ICommandHandler } from '@ocoda/event-sourcing';

import { AccountId, AccountOwnerId } from '../../domain/models';
import { AccountRepository } from '../repositories';

export class RemoveAccountOwnerCommand implements ICommand {
	constructor(public readonly accountId: string, public readonly accountOwnerId: string) {}
}

@CommandHandler(RemoveAccountOwnerCommand)
export class RemoveAccountOwnerCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: RemoveAccountOwnerCommand): Promise<boolean> {
		const accountId = AccountId.from(command.accountId);
		const account = await this.accountRepository.getById(accountId);

		const accountOwnerId = AccountOwnerId.from(command.accountOwnerId);
		account.removeOwner(accountOwnerId);

		await this.accountRepository.save(account);

		return true;
	}
}
