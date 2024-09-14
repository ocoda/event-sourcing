export class MissingCommandHandlerMetadataException extends Error {
	constructor(commandHandler: { name: string }) {
		super(
			`Missing command-handler metadata exception for ${commandHandler.name} (missing @CommandHandler() decorator?)`,
		);
	}
}
