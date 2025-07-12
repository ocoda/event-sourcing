import { DomainException } from '@ocoda/event-sourcing';
import type { BookId } from '../models';

export class BookNotFoundException extends DomainException {
	static withId(id: BookId): BookNotFoundException {
		return new BookNotFoundException('Book not found', id);
	}
}
