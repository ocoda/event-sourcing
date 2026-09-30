import { Query, QueryHandler, type IQueryHandler } from '@ocoda/event-sourcing';
import type { BookListItemDto } from '../book.dtos.js';
import { BookListProjection } from '../projections/index.js';

/** Reads the book list from the projection rather than from the event store. */
export class ListBooksQuery extends Query<BookListItemDto[]> {}

@QueryHandler(ListBooksQuery)
export class ListBooksQueryHandler implements IQueryHandler<ListBooksQuery> {
	constructor(private readonly projection: BookListProjection) {}

	async execute(): Promise<BookListItemDto[]> {
		return this.projection.list();
	}
}
