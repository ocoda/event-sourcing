import { type ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DomainError } from '@ocoda/event-sourcing';
import { DomainHttpException } from './domain-http-exceptions';

@Catch()
export class DomainExceptionsFilter extends BaseExceptionFilter {
	catch(exception: unknown, host: ArgumentsHost) {
		super.catch(
			exception instanceof DomainError ? DomainHttpException.fromDomainException(exception) : exception,
			host,
		);
	}
}
