export class EventNotFoundException extends Error {
	public static withVersion(stream: string, version: number): EventNotFoundException {
		return new EventNotFoundException(`Event with version ${version} not found in the ${stream} stream.`);
	}
}
