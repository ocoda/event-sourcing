export class MissingEventSubscriberMetadataException extends Error {
	constructor(eventSubscriber: { name: string }) {
		super(
			`Missing event-subscriber metadata exception for ${eventSubscriber.name} (missing @EventSubscriber() decorator?)`,
		);
	}
}
