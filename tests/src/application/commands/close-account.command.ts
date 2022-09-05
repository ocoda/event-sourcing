import {
  CommandHandler,
  ICommand,
  ICommandHandler,
} from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models';
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

    account.close();

    await this.accountRepository.save(account);

    return true;
  }
}
