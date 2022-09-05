import {
  CommandHandler,
  EventStream,
  ICommand,
  ICommandHandler,
} from '@ocoda/event-sourcing';
import { EventStore } from '@ocoda/event-sourcing/event-store';

import {
  Account,
  AccountId,
  AccountOwnerId,
} from '../../domain/models/account.aggregate';
import { AccountRepository } from '../repositories';

export class AddAccountOwnerCommand implements ICommand {
  constructor(
    public readonly accountId: string,
    public readonly accountOwnerId: string,
  ) {}
}

@CommandHandler(AddAccountOwnerCommand)
export class AddAccountOwnerCommandHandler implements ICommandHandler {
  constructor(private readonly accountRepository: AccountRepository) {}

  async execute(command: AddAccountOwnerCommand): Promise<boolean> {
    const accountId = AccountId.from(command.accountId);
    const account = await this.accountRepository.getById(accountId);

    const accountOwnerId = AccountOwnerId.from(command.accountOwnerId);
    account.addOwner(accountOwnerId);

    await this.accountRepository.save(account);

    return true;
  }
}
