import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions/index.js';
import { BookLoanId } from '../../domain/models/index.js';
import { BookLoanRepository } from '../repositories/index.js';

export class ExtendBookLoanCommand implements ICommand {
	constructor(
		public readonly bookId: string,
		public readonly dueOn: Date,
	) {}
}

@CommandHandler(ExtendBookLoanCommand)
export class ExtendBookLoanCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookLoanRepository) {}

	async execute(command: ExtendBookLoanCommand): Promise<boolean> {
		const bookLoanId = BookLoanId.from(command.bookId);
		const bookLoan = await this.bookRepository.getById(bookLoanId);

		if (!bookLoan) {
			throw BookLoanNotFoundException.withId(bookLoanId);
		}

		bookLoan.extend(command.dueOn);

		await this.bookRepository.save(bookLoan);

		return true;
	}
}
