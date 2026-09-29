import type { Type } from '@nestjs/common';
import type { ICommand } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a command class has no metadata, which `@CommandHandler()` assigns: no handler was ever declared for it.
 */
export class MissingCommandMetadataException extends EventSourcingError {
	override readonly name = 'MissingCommandMetadataException';
	readonly code = EventSourcingErrorCode.MissingCommandMetadata;
	/** The class name of the command. */
	readonly commandName?: string;

	constructor(details: { command: ICommand | Type<ICommand> | string }, options?: ErrorOptions) {
		const commandName = nameOf(details?.command);
		super(`Missing command metadata exception for ${commandName ?? 'unknown'}`, options);
		this.commandName = commandName;
	}
}
