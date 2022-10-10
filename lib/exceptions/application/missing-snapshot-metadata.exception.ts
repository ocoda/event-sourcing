export class MissingSnapshotMetadataException extends Error {
	constructor(handler: Function) {
		super(`Missing snapshot metadata exception for ${handler.name}. (missing @Snapshot() decorator?)`);
	}
}
