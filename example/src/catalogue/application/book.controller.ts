import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { CommandBus, QueryBus } from '@ocoda/event-sourcing';
import type { BookId } from '../domain/models';
import type { AddBookAuthorDto, AddBookDto, RemoveBookAuthorDto, RemoveBookDto } from './book.dtos';
import { AddBookAuthorCommand, AddBookCommand, RemoveBookAuthorCommand, RemoveBookCommand } from './commands';
import { GetBookByIdQuery } from './queries';

@Controller('book')
export class BookController {
	constructor(
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
	) {}

	@Post('add')
	async add(@Body() { title, authorIds, publicationDate, isbn }: AddBookDto): Promise<string> {
		const command = new AddBookCommand(title, authorIds, new Date(publicationDate), isbn);
		const bookId: BookId = await this.commandBus.execute<AddBookCommand>(command);

		return bookId.value;
	}

	@Patch(':id/add-author')
	async addAuthor(@Param('id') id: string, @Body() { authorId }: AddBookAuthorDto): Promise<void> {
		const command = new AddBookAuthorCommand(id, authorId);
		await this.commandBus.execute(command);
	}

	@Patch(':id/remove-author')
	async removeOwner(@Param('id') id: string, @Body() { authorId }: RemoveBookAuthorDto): Promise<void> {
		const command = new RemoveBookAuthorCommand(id, authorId);
		await this.commandBus.execute(command);
	}

	@Delete(':id')
	async remove(@Param('id') id: string, @Body() { reason }: RemoveBookDto): Promise<void> {
		const command = new RemoveBookCommand(id, reason);
		await this.commandBus.execute(command);
	}

	@Get(':id')
	async get(@Param('id') id: string) {
		const query = new GetBookByIdQuery(id);
		const book = await this.queryBus.execute(query);

		return book;
	}
}
