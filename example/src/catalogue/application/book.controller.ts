import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, UseFilters } from '@nestjs/common';
import { CommandBus, QueryBus } from '@ocoda/event-sourcing';
import type { AddBookDto, BookDto, BookListItemDto } from './book.dtos.js';
import { AddBookAuthorCommand, AddBookCommand, RemoveBookAuthorCommand, RemoveBookCommand } from './commands/index.js';
import { CatalogueExceptionFilter } from './exceptions/index.js';
import { GetBookByIdQuery, ListBooksQuery } from './queries/index.js';

@Controller('books')
@UseFilters(CatalogueExceptionFilter)
export class BookController {
	constructor(
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
	) {}

	@Post()
	async add(@Body() { id, title, authorIds, publicationDate, isbn }: AddBookDto): Promise<{ id: string }> {
		// AddBookCommand extends Command<string>, so the bus resolves to a string.
		const bookId = await this.commandBus.execute(
			new AddBookCommand(title, authorIds ?? [], new Date(publicationDate), isbn, id),
		);
		return { id: bookId };
	}

	@Get()
	list(): Promise<BookListItemDto[]> {
		return this.queryBus.execute(new ListBooksQuery());
	}

	@Get(':id')
	get(@Param('id') id: string): Promise<BookDto> {
		return this.queryBus.execute(new GetBookByIdQuery(id));
	}

	@Put(':id/authors/:authorId')
	@HttpCode(HttpStatus.NO_CONTENT)
	async addAuthor(@Param('id') id: string, @Param('authorId') authorId: string): Promise<void> {
		await this.commandBus.execute(new AddBookAuthorCommand(id, authorId));
	}

	@Delete(':id/authors/:authorId')
	@HttpCode(HttpStatus.NO_CONTENT)
	async removeAuthor(@Param('id') id: string, @Param('authorId') authorId: string): Promise<void> {
		await this.commandBus.execute(new RemoveBookAuthorCommand(id, authorId));
	}

	@Delete(':id')
	@HttpCode(HttpStatus.NO_CONTENT)
	async remove(@Param('id') id: string, @Body('reason') reason?: string): Promise<void> {
		await this.commandBus.execute(new RemoveBookCommand(id, reason ?? ''));
	}
}
