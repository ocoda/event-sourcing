import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class used as an aggregate has no `@Aggregate()` metadata.
 */
export class MissingAggregateMetadataException extends EventSourcingError {
	override readonly name = 'MissingAggregateMetadataException';
	readonly code = EventSourcingErrorCode.MissingAggregateMetadata;
	/** The class name of the aggregate. */
	readonly aggregateName?: string;

	constructor(details: { aggregate: Function | string }, options?: ErrorOptions) {
		const aggregateName = nameOf(details?.aggregate);
		super(
			`Missing aggregate metadata exception (${aggregateName ?? 'unknown'} aggregate missing @Aggregate() decorator?)`,
			options,
		);
		this.aggregateName = aggregateName;
	}
}
