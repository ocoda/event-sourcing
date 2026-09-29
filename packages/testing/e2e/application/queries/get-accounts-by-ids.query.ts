import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models/index.js';
import { AccountDto } from '../account.dtos.js';
import { AccountRepository } from '../repositories/index.js';

export class GetAccountsByIdsQuery implements IQuery {
	constructor(public readonly accountIds: string[]) {}
}

@QueryHandler(GetAccountsByIdsQuery)
export class GetAccountsByIdsQueryHandler implements IQueryHandler<GetAccountsByIdsQuery, AccountDto[]> {
	constructor(private readonly accountRepository: AccountRepository) {}

	public async execute(query: GetAccountsByIdsQuery): Promise<AccountDto[]> {
		const accountIds = query.accountIds.map((accountId) => AccountId.from(accountId));

		const accounts = await this.accountRepository.getByIds(accountIds);

		return accounts.filter((account) => !account.closedOn).map((account) => AccountDto.from(account));
	}
}
