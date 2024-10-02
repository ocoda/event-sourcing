import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { CommandBus, QueryBus } from '@ocoda/event-sourcing';
import type { AccountId } from '../domain/models';
import type {
	AddAccountOwnerDto,
	CreditAccountDto,
	DebitAccountDto,
	RemoveAccountOwnerDto,
	TransferBetweenAccountsDto,
} from './account.dtos';
import {
	AddAccountOwnerCommand,
	CloseAccountCommand,
	CreditAccountCommand,
	DebitAccountCommand,
	OpenAccountCommand,
	RemoveAccountOwnerCommand,
	TransferBetweenAccountsCommand,
} from './commands';
import { GetAccountByIdQuery } from './queries';

@Controller('account')
export class AccountController {
	constructor(
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
	) {}

	@Post('open')
	async open(): Promise<string> {
		const command = new OpenAccountCommand();
		const accountId: AccountId = await this.commandBus.execute<OpenAccountCommand>(command);

		return accountId.value;
	}

	@Patch(':id/add-owner')
	async addOwner(@Param('id') id: string, @Body() { ownerId }: AddAccountOwnerDto): Promise<void> {
		const command = new AddAccountOwnerCommand(id, ownerId);
		await this.commandBus.execute(command);
	}

	@Patch(':id/remove-owner')
	async removeOwner(@Param('id') id: string, @Body() { ownerId }: RemoveAccountOwnerDto): Promise<void> {
		const command = new RemoveAccountOwnerCommand(id, ownerId);
		await this.commandBus.execute(command);
	}

	@Patch(':id/credit')
	async credit(@Param('id') id: string, @Body() { amount }: CreditAccountDto): Promise<void> {
		const command = new CreditAccountCommand(id, amount);
		await this.commandBus.execute(command);
	}

	@Patch(':id/debit')
	async debit(@Param('id') id: string, @Body() { amount }: DebitAccountDto): Promise<void> {
		const command = new DebitAccountCommand(id, amount);
		await this.commandBus.execute(command);
	}

	@Patch(':id/transfer-to/:recipient')
	async transfer(
		@Param('id') debitAccountId: string,
		@Param('recipient') creditAccountId: string,
		@Body() { amount }: TransferBetweenAccountsDto,
	): Promise<void> {
		const command = new TransferBetweenAccountsCommand(debitAccountId, creditAccountId, amount);
		await this.commandBus.execute(command);
	}

	@Delete(':id')
	async close(@Param('id') id: string): Promise<void> {
		const command = new CloseAccountCommand(id);
		await this.commandBus.execute(command);
	}

	@Get(':id')
	async get(@Param('id') id: string) {
		const query = new GetAccountByIdQuery(id);
		const account = await this.queryBus.execute(query);

		return account;
	}
}
