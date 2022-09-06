export class SnapshotNotFoundException extends Error {
	public static withVersion(stream: string, version: number): SnapshotNotFoundException {
		return new SnapshotNotFoundException(`Snapshot with version ${version} not found in the ${stream} stream.`);
	}
}
