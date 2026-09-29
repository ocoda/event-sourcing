import type { Type } from '@nestjs/common';
import { COMMAND_HANDLER_METADATA } from '../../decorators/index.js';
import type { CommandHandlerMetadata, ICommandHandler } from '../../interfaces/index.js';

export const getCommandHandlerMetadata = (commandHandler: Type<ICommandHandler>): CommandHandlerMetadata => {
	return Reflect.getMetadata(COMMAND_HANDLER_METADATA, commandHandler) ?? {};
};
