import type { EventStream } from '../../models';

/**
 * Represents an exception that occurs when the event being persisted
 * has a version lower that the latest version present.
 * @extends {Error}
 */
export class EventStoreVersionConflictException extends Error {
	constructor({ streamId }: EventStream, eventVersion: number, latestVersion: number, error?: Error) {
		super(
			`Appending event(s) to the ${streamId} stream failed due to a version conflict. Expected to append version ${eventVersion}, but latest is ${latestVersion}.`,
		);
		this.stack = error?.stack;
	}
}
