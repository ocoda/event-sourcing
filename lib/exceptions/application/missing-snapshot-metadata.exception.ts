export class MissingSnapshotMetadataException extends Error {
	constructor(aggregate: Function) {
		super(`Missing snapshot metadata exception for ${aggregate.constructor} (missing @Snapshot() decorator?)`);
	}
}
