export class MissingSnapshotMetadataException extends Error {
	constructor(handler: { name: string }) {
		super(`Missing snapshot metadata exception for ${handler.name}. (missing @Snapshot() decorator?)`);
	}
}
