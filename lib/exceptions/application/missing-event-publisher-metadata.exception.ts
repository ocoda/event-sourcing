export class MissingEventPublisherMetadataException extends Error {
	constructor(eventPublisher: Function) {
		super(
			`Missing event-publisher metadata exception for ${eventPublisher.name} (missing @EventPublisher() decorator?)`,
		);
	}
}
