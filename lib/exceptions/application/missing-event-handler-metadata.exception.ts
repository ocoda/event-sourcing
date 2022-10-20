export class MissingEventHandlerMetadataException extends Error {
	constructor(eventHandler: Function) {
		super(`Missing event-handler metadata exception for ${eventHandler.name} (missing @EventHandler() decorator?)`);
	}
}
