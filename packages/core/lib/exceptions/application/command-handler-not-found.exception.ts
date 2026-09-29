import type { Type } from '@nestjs/common';
import type { ICommand } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a command is executed that has no registered handler.
 */
export class CommandHandlerNotFoundException extends EventSourcingError {
	override readonly name = 'CommandHandlerNotFoundException';
	readonly code = EventSourcingErrorCode.CommandHandlerNotFound;
	/** The class name of the command. */
	readonly commandName?: string;

	constructor(details: { command: ICommand | Type<ICommand> | string }, options?: ErrorOptions) {
		const commandName = nameOf(details?.command);
		super(`The command handler for the "${commandName ?? 'unknown'}" command was not found.`, options);
		this.commandName = commandName;
	}
}
