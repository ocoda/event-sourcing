import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { AccountNotFoundException } from '../../domain/exceptions';
import { AccountId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { AccountRepository } from '../repositories';

export class CloseAccountCommand implements ICommand {
	constructor(public readonly accountId: string) {}
}

@CommandHandler(CloseAccountCommand)
export class CloseAccountCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: CloseAccountCommand): Promise<boolean> {
		const accountId = AccountId.from(command.accountId);
		const account = await this.accountRepository.getById(accountId);

		if (!account) {
			throw AccountNotFoundException.withId(accountId);
		}

		account.close();

		await this.accountRepository.save(account);

		return true;
	}
}
