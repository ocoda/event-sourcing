import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import {
	AccountId,
	AccountInsufficientFundsException,
	AccountInvalidAmountException,
	AccountOwnerAlreadyExistsException,
	AccountOwnerNotFoundException,
	AccountTransferFailedEvent,
	AccountTransferSucceededEvent,
} from '../../domain';
// biome-ignore lint/style/useImportType: DI
import { AccountRepository } from '../repositories';

export class TransferBetweenAccountsCommand implements ICommand {
	constructor(
		public readonly fromAccountId: string,
		public readonly toAccountId: string,
		public readonly amount: number,
	) {}
}

@CommandHandler(TransferBetweenAccountsCommand)
export class TransferBetweenAccountsCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: TransferBetweenAccountsCommand): Promise<boolean> {
		const fromAccountId = AccountId.from(command.fromAccountId);
		const toAccountId = AccountId.from(command.toAccountId);

		const fromAccount = await this.accountRepository.getById(fromAccountId);
		const toAccount = await this.accountRepository.getById(toAccountId);

		try {
			fromAccount.debit(command.amount);
			toAccount.credit(command.amount);
		} catch (error) {
			if (
				error instanceof AccountInsufficientFundsException ||
				error instanceof AccountInvalidAmountException ||
				error instanceof AccountOwnerAlreadyExistsException ||
				error instanceof AccountOwnerNotFoundException
			) {
				fromAccount.applyEvent(
					new AccountTransferFailedEvent(fromAccountId.value, toAccountId.value, command.amount, error.message),
				);
				await this.accountRepository.save(fromAccount);
				throw error;
			}
			throw error;
		}

		fromAccount.applyEvent(new AccountTransferSucceededEvent(fromAccountId.value, toAccountId.value, command.amount));
		await Promise.all([this.accountRepository.save(fromAccount), this.accountRepository.save(toAccount)]);

		return true;
	}
}
