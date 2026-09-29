import { isEventSourcingError } from '@ocoda/event-sourcing';

/**
 * Asserts that the promise rejects with the library error of the given class, with the given fields, and returns the
 * error for further checks.
 */
export const expectRejectionOfClass = async <E extends Error>(
	promise: Promise<unknown>,
	exception: abstract new (...args: never[]) => E,
	fields?: Record<string, unknown>,
): Promise<E> => {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(isEventSourcingError(error), `expected a rejection with ${exception.name}, got ${String(error)}`).toBe(true);
	expect((error as Error).name).toBe(exception.name);
	if (fields) {
		expect(error).toMatchObject(fields);
	}
	return error as E;
};

/** Reads every batch of a reader. */
export const drain = async <T>(batches: AsyncIterable<T[]>): Promise<T[]> => {
	const items: T[] = [];
	for await (const batch of batches) items.push(...batch);
	return items;
};
