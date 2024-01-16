import { CommandHandler, ICommand, ICommandHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models';
import { AccountRepository } from '../repositories';

export class DebitAccountCommand implements ICommand {
	constructor(
		public readonly accountId: string,
		public readonly amount: number,
	) {}
}

@CommandHandler(DebitAccountCommand)
export class DebitAccountCommandHandler implements ICommandHandler {
	constructor(private readonly accountRepository: AccountRepository) {}

	async execute(command: DebitAccountCommand): Promise<boolean> {
		const accountId = AccountId.from(command.accountId);
		const account = await this.accountRepository.getById(accountId);

		account.debit(command.amount);

		await this.accountRepository.save(account);

		return true;
	}
}
