import {
	Body,
	Controller,
	Delete,
	Get,
	HttpException,
	HttpStatus,
	InternalServerErrorException,
	Param,
	Patch,
	Post,
} from '@nestjs/common';
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
import { AccountNotFoundException } from './repositories/exceptions/account-not-found.exception';

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
		try {
			const command = new AddAccountOwnerCommand(id, ownerId);

			await this.commandBus.execute(command);
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}

	@Patch(':id/remove-owner')
	async removeOwner(@Param('id') id: string, @Body() { ownerId }: RemoveAccountOwnerDto): Promise<void> {
		try {
			const command = new RemoveAccountOwnerCommand(id, ownerId);

			await this.commandBus.execute(command);
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}

	@Patch(':id/credit')
	async credit(@Param('id') id: string, @Body() { amount }: CreditAccountDto): Promise<void> {
		try {
			const command = new CreditAccountCommand(id, amount);

			await this.commandBus.execute(command);
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}

	@Patch(':id/debit')
	async debit(@Param('id') id: string, @Body() { amount }: DebitAccountDto): Promise<void> {
		try {
			const command = new DebitAccountCommand(id, amount);

			await this.commandBus.execute(command);
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}

	@Patch(':id/transfer-to/:recipient')
	async transfer(
		@Param('id') debitAccountId: string,
		@Param('recipient') creditAccountId: string,
		@Body() { amount }: TransferBetweenAccountsDto,
	): Promise<void> {
		try {
			const command = new TransferBetweenAccountsCommand(debitAccountId, creditAccountId, amount);

			await this.commandBus.execute(command);
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}

	@Delete(':id')
	async close(@Param('id') id: string): Promise<void> {
		try {
			const command = new CloseAccountCommand(id);

			await this.commandBus.execute(command);
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}

	@Get(':id')
	async get(@Param('id') id: string) {
		try {
			const query = new GetAccountByIdQuery(id);

			const account = await this.queryBus.execute(query);

			return account;
		} catch (error) {
			switch (error.constructor) {
				case AccountNotFoundException:
					throw new HttpException(`${error.message} not found`, HttpStatus.NOT_FOUND);
				default:
					throw new InternalServerErrorException(error);
			}
		}
	}
}
