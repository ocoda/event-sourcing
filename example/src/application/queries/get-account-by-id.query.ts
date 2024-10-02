import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { AccountNotFoundException } from '../../domain/exceptions';
import { AccountId } from '../../domain/models';
import { AccountDto } from '../account.dtos';
// biome-ignore lint/style/useImportType: DI
import { AccountRepository } from '../repositories';

export class GetAccountByIdQuery implements IQuery {
	constructor(public readonly accountId: string) {}
}

@QueryHandler(GetAccountByIdQuery)
export class GetAccountByIdQueryHandler implements IQueryHandler<GetAccountByIdQuery, AccountDto> {
	constructor(private readonly accountRepository: AccountRepository) {}

	public async execute(query: GetAccountByIdQuery): Promise<AccountDto> {
		const accountId = AccountId.from(query.accountId);

		const account = await this.accountRepository.getById(accountId);

		if (!account || account.closedOn) {
			throw AccountNotFoundException.withId(accountId);
		}

		return AccountDto.from(account);
	}
}
