import { HttpException, HttpStatus } from '@nestjs/common';
import type { DomainException } from '@ocoda/event-sourcing';
import { BookNotFoundException, InvalidIsbnException } from '../../domain/exceptions';

export class DomainHttpException extends HttpException {
	static fromDomainException(error: DomainException): DomainHttpException {
		switch (error.constructor) {
			case BookNotFoundException:
				return new HttpException({ id: error.id, message: error.message }, HttpStatus.NOT_FOUND);
			case InvalidIsbnException:
				return new HttpException({ id: error.id, message: error.message }, HttpStatus.BAD_REQUEST);
			default:
				return new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}
}
