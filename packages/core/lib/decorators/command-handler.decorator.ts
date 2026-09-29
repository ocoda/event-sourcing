import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import type { CommandMetadata, ICommand, ICommandHandler } from '../interfaces/index.js';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from './constants.js';

/**
 * Decorator that marks a class as a command handler. A command handler handles commands (actions) executed by your application code.
 * @description The decorated class must implement `ICommandHandler`: its `execute` takes the command and resolves to
 * the command's result type (see `Command<TResult>`). The `CommandBus` routes the instances of this command class to
 * it, and those of its subclasses that have no handler of their own.
 * @param command The command class handled by this handler.
 * @example `@CommandHandler(OpenAccountCommand)`
 */
export const CommandHandler = <TCommand extends ICommand>(
	command: Type<TCommand>,
): ((target: Type<ICommandHandler<TCommand>>) => void) => {
	return (target) => {
		// Kept for 3.x code that reads getCommandMetadata(); the CommandBus keys its handlers by class.
		if (!Reflect.hasMetadata(COMMAND_METADATA, command)) {
			Reflect.defineMetadata(COMMAND_METADATA, { id: randomUUID() } as CommandMetadata, command);
		}
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command }, target);
	};
};
