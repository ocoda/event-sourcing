import { randomUUID } from 'crypto';
import 'reflect-metadata';
import { CommandMetadata, ICommand } from '../interfaces';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from './constants';

/**
 * Decorator that marks a class as a command handler. A command handler
 * handles commands (actions) executed by your application code.
 *
 * The decorated class must implement the `ICommandHandler` interface.
 *
 * @param command command *type* to be handled by this handler.
 */
export const CommandHandler = (command: ICommand): ClassDecorator => {
	return (target: object) => {
		if (!Reflect.hasMetadata(COMMAND_METADATA, command)) {
			Reflect.defineMetadata(COMMAND_METADATA, { id: randomUUID() } as CommandMetadata, command);
		}
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, command, target);
	};
};
