import { type ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { EventSourcingErrorCode, isEventSourcingError } from '@ocoda/event-sourcing';

/**
 * Maps the library's errors that a client can cause to HTTP responses, and leaves everything else to Nest. The errors
 * are matched on their stable `code`, not on their message.
 */
@Catch()
export class EventSourcingExceptionFilter extends BaseExceptionFilter {
	catch(exception: unknown, host: ArgumentsHost) {
		// Another writer appended to the stream since the aggregate was loaded, or the stream of a new aggregate exists.
		if (isEventSourcingError(exception, EventSourcingErrorCode.EventStoreVersionConflict)) {
			const { message, aggregateId, expectedVersion, actualVersion } = exception;
			return super.catch(
				new HttpException(
					{ statusCode: HttpStatus.CONFLICT, message, id: aggregateId, expectedVersion, actualVersion },
					HttpStatus.CONFLICT,
				),
				host,
			);
		}

		// An id in the path or the body that isn't a valid UUID.
		if (isEventSourcingError(exception, EventSourcingErrorCode.InvalidId)) {
			return super.catch(
				new HttpException({ statusCode: HttpStatus.BAD_REQUEST, message: exception.message }, HttpStatus.BAD_REQUEST),
				host,
			);
		}

		return super.catch(exception, host);
	}
}
