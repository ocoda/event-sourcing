import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookId, BookLoan, BookLoanId, LibraryMemberId } from '../../domain/models/index.js';
import { BookLoanRepository } from '../repositories/index.js';

/** Lends a book to a library member and resolves to the id of the loan. */
export class CreateBookLoanCommand extends Command<string> {
	constructor(
		public readonly bookId: string,
		public readonly libraryMemberId: string,
		public readonly loanedOn: Date,
		public readonly dueOn: Date,
	) {
		super();
	}
}

@CommandHandler(CreateBookLoanCommand)
export class CreateBookLoanCommandHandler implements ICommandHandler<CreateBookLoanCommand> {
	constructor(private readonly bookLoanRepository: BookLoanRepository) {}

	async execute(command: CreateBookLoanCommand): Promise<string> {
		const bookLoanId = BookLoanId.generate();

		const bookLoan = BookLoan.create(
			bookLoanId,
			BookId.from(command.bookId),
			LibraryMemberId.from(command.libraryMemberId),
			command.loanedOn,
			command.dueOn,
		);

		await this.bookLoanRepository.save(bookLoan);

		return bookLoanId.value;
	}
}
