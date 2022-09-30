export class MissingCommandHandlerMetadataException extends Error {
	constructor(commandHandler: Function) {
		super(
			`Missing command-handler metadata exception for ${commandHandler.constructor} (missing @CommandHandler() decorator?)`,
		);
	}
}
