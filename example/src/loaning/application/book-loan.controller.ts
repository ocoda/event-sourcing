import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { CommandBus, QueryBus } from '@ocoda/event-sourcing';
import type { BookLoanId } from '../domain/models';
import { CreateBookLoanCommand, ExtendBookLoanCommand, ReturnBookLoanCommand } from './commands';
import type { CreateBookLoanDto, ExtendBookLoanDto } from './book-loan.dtos';
import { GetBookLoanByIdQuery } from './queries';

@Controller('book-loan')
export class BookLoanController {
	constructor(
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
	) {}

	@Post('create')
	async create(@Body() { bookId, libraryMemberId, loanedOn, dueOn }: CreateBookLoanDto): Promise<string> {
		const command = new CreateBookLoanCommand(bookId, libraryMemberId, new Date(loanedOn), new Date(dueOn));
		const bookLoanId: BookLoanId = await this.commandBus.execute<CreateBookLoanCommand>(command);

		return bookLoanId.value;
	}

	@Patch(':id/extend')
	async extend(@Param('id') id: string, @Body() { dueOn }: ExtendBookLoanDto): Promise<void> {
		const command = new ExtendBookLoanCommand(id, new Date(dueOn));
		await this.commandBus.execute(command);
	}

	@Patch(':id/return')
	async return(@Param('id') id: string): Promise<void> {
		const command = new ReturnBookLoanCommand(id);
		await this.commandBus.execute(command);
	}

	@Get(':id')
	async get(@Param('id') id: string) {
		const query = new GetBookLoanByIdQuery(id);
		const book = await this.queryBus.execute(query);

		return book;
	}
}
