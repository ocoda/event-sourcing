import { IQuery, IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models';
import { AccountDto } from '../account.dtos';
import { AccountRepository } from '../repositories';

export class GetAccountsQuery implements IQuery {}

@QueryHandler(GetAccountsQuery)
export class GetAccountsQueryHandler implements IQueryHandler<GetAccountsQuery, AccountDto[]> {
	constructor(private readonly accountRepository: AccountRepository) {}

	public async execute(query: GetAccountsQuery): Promise<AccountDto[]> {
		const accounts = await this.accountRepository.getAll();

		return accounts.reduce<AccountDto[]>((acc, account) => {
			return account.closedOn ? acc : [...acc, AccountDto.from(account)];
		}, []);
	}
}
