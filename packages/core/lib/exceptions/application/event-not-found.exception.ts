export class EventNotFoundException extends Error {
	constructor(streamId: string, version: number) {
		super(`Event with version ${version} not found in the ${streamId} stream.`);
	}
}
