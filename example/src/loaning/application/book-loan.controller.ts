import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseFilters } from '@nestjs/common';
import { CommandBus, QueryBus } from '@ocoda/event-sourcing';
import { parseDate } from '../../parse-date.js';
import type { BookLoanDto, CreateBookLoanDto } from './book-loan.dtos.js';
import { CreateBookLoanCommand, ExtendBookLoanCommand, ReturnBookLoanCommand } from './commands/index.js';
import { LoaningExceptionFilter } from './exceptions/index.js';
import { GetBookLoanByIdQuery } from './queries/index.js';

@Controller('loans')
@UseFilters(LoaningExceptionFilter)
export class BookLoanController {
	constructor(
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
	) {}

	@Post()
	async create(@Body() { bookId, libraryMemberId, loanedOn, dueOn }: CreateBookLoanDto): Promise<{ id: string }> {
		const command = new CreateBookLoanCommand(
			bookId,
			libraryMemberId,
			loanedOn === undefined ? new Date() : parseDate(loanedOn, 'loanedOn'),
			parseDate(dueOn, 'dueOn'),
		);
		return { id: await this.commandBus.execute(command) };
	}

	@Get(':id')
	get(@Param('id') id: string): Promise<BookLoanDto> {
		return this.queryBus.execute(new GetBookLoanByIdQuery(id));
	}

	@Post(':id/extend')
	@HttpCode(HttpStatus.NO_CONTENT)
	async extend(@Param('id') id: string, @Body('dueOn') dueOn: string): Promise<void> {
		await this.commandBus.execute(new ExtendBookLoanCommand(id, parseDate(dueOn, 'dueOn')));
	}

	@Post(':id/return')
	@HttpCode(HttpStatus.NO_CONTENT)
	async return(@Param('id') id: string): Promise<void> {
		await this.commandBus.execute(new ReturnBookLoanCommand(id));
	}
}
