import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';

import { Account, AccountId, AccountOwnerId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { AccountRepository } from '../repositories';

export class OpenAccountCommand implements ICommand {
	constructor(public readonly accountOwnerIds?: string[]) {}
}

@CommandHandler(OpenAccountCommand)
export class OpenAccountCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: OpenAccountCommand): Promise<AccountId> {
		const accountId = AccountId.generate();

		const account = Account.open(accountId, command.accountOwnerIds?.map(AccountOwnerId.from));

		await this.accountRepository.save(account);

		return accountId;
	}
}
