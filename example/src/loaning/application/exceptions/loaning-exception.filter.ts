import { type ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { BookLoanAlreadyReturnedException, BookLoanNotFoundException } from '../../domain/exceptions/index.js';

/** Maps the domain exceptions of loaning to HTTP responses. */
@Catch(BookLoanNotFoundException, BookLoanAlreadyReturnedException)
export class LoaningExceptionFilter extends BaseExceptionFilter {
	catch(exception: BookLoanNotFoundException | BookLoanAlreadyReturnedException, host: ArgumentsHost) {
		const status = exception instanceof BookLoanNotFoundException ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
		super.catch(
			new HttpException({ statusCode: status, message: exception.message, id: exception.id?.value }, status),
			host,
		);
	}
}
