import { BadRequestException } from '@nestjs/common';

/**
 * Reads a date from a request, or answers `400 Bad Request` when it's missing or not a date. Without this check an
 * invalid date reaches the aggregate, whose `toISOString()` throws a `RangeError`: a `500`.
 */
export const parseDate = (value: unknown, field: string): Date => {
	const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
	if (Number.isNaN(date.getTime())) {
		throw new BadRequestException(`${field} must be a date, such as 2030-01-15 or 2030-01-15T10:00:00Z`);
	}
	return date;
};
