import { DomainException } from '@ocoda/event-sourcing';
import type { BookLoanId } from '../models/book-loan/book-loan-id.vo.js';

export class BookLoanAlreadyReturnedException extends DomainException {
	static withId(id: BookLoanId): BookLoanAlreadyReturnedException {
		return new BookLoanAlreadyReturnedException('Book loan is already returned', id);
	}
}
