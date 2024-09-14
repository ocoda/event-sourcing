import { IQuery, IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models';
import { AccountDto } from '../account.dtos';
import { AccountRepository } from '../repositories';

export class GetAccountsQuery implements IQuery {}

@QueryHandler(GetAccountsQuery)
export class GetAccountsQueryHandler implements IQueryHandler<GetAccountsQuery, AccountDto[]> {
	constructor(private readonly accountRepository: AccountRepository) {}

	public async execute(query: GetAccountsQuery): Promise<AccountDto[]> {
		const accounts: AccountDto[] = [];
		for (const account of await this.accountRepository.getAll()) {
			if (!account.closedOn) {
				accounts.push(AccountDto.from(account));
			}
		}

		return accounts;
	}
}
