import type { Account } from '../domain/models';

export class AddAccountOwnerDto {
	ownerId: string;
}

export class CreditAccountDto {
	amount: number;
}

export class DebitAccountDto {
	amount: number;
}

export class RemoveAccountOwnerDto {
	ownerId: string;
}

export class TransferBetweenAccountsDto {
	amount: number;
}

export class AccountDto {
	constructor(
		public readonly id: string,
		public readonly ownerIds: string[],
		public readonly balance: number,
		public readonly openedOn: Date,
	) {}

	static from(account: Account): AccountDto {
		return new AccountDto(
			account.id.value,
			account.ownerIds?.map(({ value }) => value),
			account.balance,
			account.openedOn,
		);
	}
}
