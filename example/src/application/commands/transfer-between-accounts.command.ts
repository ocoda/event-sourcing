import { CommandHandler, ICommand, ICommandHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models';
import { AccountRepository } from '../repositories';

export class TransferBetweenAccountsCommand implements ICommand {
	constructor(
		public readonly debitAccountId: string,
		public readonly creditAccountId: string,
		public readonly amount: number,
	) {}
}

@CommandHandler(TransferBetweenAccountsCommand)
export class TransferBetweenAccountsCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: TransferBetweenAccountsCommand): Promise<boolean> {
		const debitAccountId = AccountId.from(command.debitAccountId);
		const creditAccountId = AccountId.from(command.creditAccountId);

		const debitAccount = await this.accountRepository.getById(debitAccountId);
		const creditAccount = await this.accountRepository.getById(creditAccountId);

		debitAccount.debit(command.amount);
		creditAccount.credit(command.amount);

		await Promise.all([this.accountRepository.save(creditAccount), this.accountRepository.save(debitAccount)]);

		return true;
	}
}
