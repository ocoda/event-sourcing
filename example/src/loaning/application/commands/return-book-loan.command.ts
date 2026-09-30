import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions/index.js';
import { BookLoanId } from '../../domain/models/index.js';
import { BookLoanRepository } from '../repositories/index.js';

export class ReturnBookLoanCommand extends Command {
	constructor(public readonly bookLoanId: string) {
		super();
	}
}

@CommandHandler(ReturnBookLoanCommand)
export class ReturnBookLoanCommandHandler implements ICommandHandler<ReturnBookLoanCommand> {
	constructor(private readonly bookLoanRepository: BookLoanRepository) {}

	async execute(command: ReturnBookLoanCommand): Promise<void> {
		const bookLoanId = BookLoanId.from(command.bookLoanId);
		const bookLoan = await this.bookLoanRepository.getById(bookLoanId);

		if (!bookLoan) {
			throw BookLoanNotFoundException.withId(bookLoanId);
		}

		bookLoan.return();

		await this.bookLoanRepository.save(bookLoan);
	}
}
