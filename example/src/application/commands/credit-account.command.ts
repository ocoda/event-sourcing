import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { AccountNotFoundException } from '../../domain/exceptions';
import { AccountId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { AccountRepository } from '../repositories';

export class CreditAccountCommand implements ICommand {
	constructor(
		public readonly accountId: string,
		public readonly amount: number,
	) {}
}

@CommandHandler(CreditAccountCommand)
export class CreditAccountCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: CreditAccountCommand): Promise<boolean> {
		const accountId = AccountId.from(command.accountId);
		const account = await this.accountRepository.getById(accountId);

		if (!account) {
			throw AccountNotFoundException.withId(accountId);
		}

		account.credit(command.amount);

		await this.accountRepository.save(account);

		return true;
	}
}
