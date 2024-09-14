export class MissingCommandMetadataException extends Error {
	constructor(command: { name: string }) {
		super(`Missing command metadata exception for ${command.name}`);
	}
}
