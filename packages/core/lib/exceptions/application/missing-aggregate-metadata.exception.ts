export class MissingAggregateMetadataException extends Error {
	constructor(aggregate: { name: string }) {
		super(`Missing aggregate metadata exception (${aggregate.name} aggregate missing @Aggregate() decorator?)`);
	}
}
