export class MissingEventListenerMetadataException extends Error {
	constructor(eventListener: Function) {
		super(
			`Missing event-listener metadata exception for ${eventListener.constructor} (missing @EventListener() decorator?)`,
		);
	}
}
