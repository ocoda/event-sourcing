import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { CommandMetadata, ICommand } from '../interfaces';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from './constants';

/**
 * Decorator that marks a class as a command handler. A command handler handles commands (actions) executed by your application code.
 * @description The decorated class must extend the `ICommandHandler` class. The handler automatically assigns an id to the command metadata.
 * @param {ICommand} command The command constructor for the commands to be handled by this handler.
 * @returns {ClassDecorator}
 * @example `@CommandHandler(OpenAccountCommand)`
 */
export const CommandHandler = (command: ICommand): ClassDecorator => {
	return (target: object) => {
		if (!Reflect.hasMetadata(COMMAND_METADATA, command)) {
			Reflect.defineMetadata(COMMAND_METADATA, { id: randomUUID() } as CommandMetadata, command);
		}
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command }, target);
	};
};
