export class MissingAggregateMetadataException extends Error {
	constructor(aggregate: Function) {
		super(`Missing aggregate metadata exception (${aggregate.constructor} aggregate missing @Aggregate() decorator?)`);
	}
}
