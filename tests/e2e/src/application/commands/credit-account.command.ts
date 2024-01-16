import { CommandHandler, ICommand, ICommandHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models';
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

		account.credit(command.amount);

		await this.accountRepository.save(account);

		return true;
	}
}
