export class MissingEventSerializerMetadataException extends Error {
	constructor(eventSerializer: Function) {
		super(
			`Missing event-serializer metadata exception for ${eventSerializer.constructor} (missing @EventSerializer() decorator?)`,
		);
	}
}
