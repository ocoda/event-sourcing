import { type ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { BookNotFoundException, InvalidIsbnException } from '../../domain/exceptions/index.js';

/** Maps the domain exceptions of the catalogue to HTTP responses. */
@Catch(BookNotFoundException, InvalidIsbnException)
export class CatalogueExceptionFilter extends BaseExceptionFilter {
	catch(exception: BookNotFoundException | InvalidIsbnException, host: ArgumentsHost) {
		const status = exception instanceof BookNotFoundException ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST;
		super.catch(
			new HttpException({ statusCode: status, message: exception.message, id: exception.id?.value }, status),
			host,
		);
	}
}
