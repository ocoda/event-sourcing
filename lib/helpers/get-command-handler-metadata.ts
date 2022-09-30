import { COMMAND_HANDLER_METADATA } from '../decorators';
import { CommandHandlerMetadata } from '../interfaces';

export const getCommandHandlerMetadata = (commandHandler: Function): CommandHandlerMetadata => {
	return Reflect.getMetadata(COMMAND_HANDLER_METADATA, commandHandler) ?? {};
};
