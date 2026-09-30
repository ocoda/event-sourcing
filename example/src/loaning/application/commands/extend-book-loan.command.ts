import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions/index.js';
import { BookLoanId } from '../../domain/models/index.js';
import { BookLoanRepository } from '../repositories/index.js';

export class ExtendBookLoanCommand extends Command {
	constructor(
		public readonly bookLoanId: string,
		public readonly dueOn: Date,
	) {
		super();
	}
}

@CommandHandler(ExtendBookLoanCommand)
export class ExtendBookLoanCommandHandler implements ICommandHandler<ExtendBookLoanCommand> {
	constructor(private readonly bookLoanRepository: BookLoanRepository) {}

	async execute(command: ExtendBookLoanCommand): Promise<void> {
		const bookLoanId = BookLoanId.from(command.bookLoanId);
		const bookLoan = await this.bookLoanRepository.getById(bookLoanId);

		if (!bookLoan) {
			throw BookLoanNotFoundException.withId(bookLoanId);
		}

		bookLoan.extend(command.dueOn);

		await this.bookLoanRepository.save(bookLoan);
	}
}
