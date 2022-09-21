export class SnapshotNotFoundException extends Error {
	constructor(stream: string, version: number) {
		super(`Snapshot with version ${version} not found in the ${stream} stream.`);
	}
}
