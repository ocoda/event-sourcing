import { HttpException, HttpStatus } from '@nestjs/common';
import type { DomainException } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions';

export class DomainHttpException extends HttpException {
	static fromDomainException(error: DomainException): DomainHttpException {
		switch (error.constructor) {
			case BookLoanNotFoundException:
				return new HttpException({ id: error.id, message: error.message }, HttpStatus.NOT_FOUND);
			default:
				return new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}
}
