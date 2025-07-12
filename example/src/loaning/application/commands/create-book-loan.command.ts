import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookId, BookLoan, BookLoanId, LibraryMemberId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookLoanRepository } from '../repositories';

export class CreateBookLoanCommand implements ICommand {
	constructor(
		public readonly bookId: string,
		public readonly libraryMemberId: string,
		public readonly loanedOn: Date,
		public readonly dueOn: Date,
	) {}
}

@CommandHandler(CreateBookLoanCommand)
export class CreateBookLoanCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookLoanRepository) {}

	async execute(command: CreateBookLoanCommand): Promise<BookLoanId> {
		const bookLoanId = BookLoanId.generate();

		const bookLoan = BookLoan.create(
			bookLoanId,
			BookId.from(command.bookId),
			LibraryMemberId.from(command.libraryMemberId),
			command.loanedOn,
			command.dueOn,
		);

		await this.bookRepository.save(bookLoan);

		return bookLoanId;
	}
}
