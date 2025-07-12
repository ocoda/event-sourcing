import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookLoanId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookLoanRepository } from '../repositories';
import { BookLoanNotFoundException } from '../../domain/exceptions';

export class ReturnBookLoanCommand implements ICommand {
	constructor(public readonly bookId: string) {}
}

@CommandHandler(ReturnBookLoanCommand)
export class ReturnBookLoanCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookLoanRepository) {}

	async execute(command: ReturnBookLoanCommand): Promise<boolean> {
		const bookLoanId = BookLoanId.from(command.bookId);
		const bookLoan = await this.bookRepository.getById(bookLoanId);

		if (!bookLoan) {
			throw BookLoanNotFoundException.withId(bookLoanId);
		}

		bookLoan.return();

		await this.bookRepository.save(bookLoan);

		return true;
	}
}
