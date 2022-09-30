export class MissingAggregateMetadataException extends Error {
	constructor(aggregate: Function) {
		super(`Missing aggregate metadata exception (${aggregate.name} aggregate missing @Aggregate() decorator?)`);
	}
}
