export class MissingCommandMetadataException extends Error {
	constructor(command: Function) {
		super(`Missing command metadata exception for ${command.name}`);
	}
}
