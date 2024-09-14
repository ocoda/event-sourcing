import { Type } from '@nestjs/common';
import { COMMAND_HANDLER_METADATA } from '../../decorators';
import { CommandHandlerMetadata, ICommandHandler } from '../../interfaces';

export const getCommandHandlerMetadata = (commandHandler: Type<ICommandHandler>): CommandHandlerMetadata => {
	return Reflect.getMetadata(COMMAND_HANDLER_METADATA, commandHandler) ?? {};
};
