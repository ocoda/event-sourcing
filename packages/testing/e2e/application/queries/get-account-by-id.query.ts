import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { AccountId } from '../../domain/models/index.js';
import { AccountDto } from '../account.dtos.js';
import { AccountRepository } from '../repositories/index.js';

export class GetAccountByIdQuery implements IQuery {
	constructor(public readonly accountId: string) {}
}

@QueryHandler(GetAccountByIdQuery)
export class GetAccountByIdQueryHandler implements IQueryHandler<GetAccountByIdQuery, AccountDto | undefined> {
	constructor(private readonly accountRepository: AccountRepository) {}

	public async execute(query: GetAccountByIdQuery): Promise<AccountDto | undefined> {
		const accountId = AccountId.from(query.accountId);

		const account = await this.accountRepository.getById(accountId);

		if (account.closedOn) {
			return;
		}

		return AccountDto.from(account);
	}
}
