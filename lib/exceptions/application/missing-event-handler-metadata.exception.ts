export class MissingEventHandlerMetadataException extends Error {
	constructor(eventHandler: { name: string }) {
		super(`Missing event-handler metadata exception for ${eventHandler.name} (missing @EventHandler() decorator?)`);
	}
}
