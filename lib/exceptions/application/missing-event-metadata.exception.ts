export class MissingEventMetadataException extends Error {
	constructor(event: { name: string }) {
		super(`Missing event metadata exception for ${event.name} (missing @Event() decorator?)`);
	}
}
