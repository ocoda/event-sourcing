export class MissingEventSerializerMetadataException extends Error {
	constructor(eventSerializer: { name: string }) {
		super(
			`Missing event-serializer metadata exception for ${eventSerializer.name} (missing @EventSerializer() decorator?)`,
		);
	}
}
