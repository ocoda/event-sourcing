import type { ICommandHandler } from '@ocoda/event-sourcing/interfaces';

export class InvalidCommandHandlerException extends Error {
	constructor(commandHandler: ICommandHandler) {
		super(
			`Invalid command handler instance provided. Expected an instance of ICommandHandler, but got ${commandHandler.constructor.name}.`,
		);
	}
}
