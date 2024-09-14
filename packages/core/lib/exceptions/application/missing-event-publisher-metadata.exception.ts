export class MissingEventPublisherMetadataException extends Error {
	constructor(eventPublisher: { name: string }) {
		super(
			`Missing event-publisher metadata exception for ${eventPublisher.name} (missing @EventPublisher() decorator?)`,
		);
	}
}
