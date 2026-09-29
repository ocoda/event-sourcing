import { DomainException } from '@ocoda/event-sourcing';
import type { BookLoanId } from '../models/index.js';

export class BookLoanNotFoundException extends DomainException {
	static withId(id: BookLoanId): BookLoanNotFoundException {
		return new BookLoanNotFoundException('Book loan not found', id);
	}
}
