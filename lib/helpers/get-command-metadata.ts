import { Type } from '@nestjs/common';
import { COMMAND_METADATA } from '../decorators';
import { CommandMetadata, ICommand } from '../interfaces';

export const getCommandMetadata = (command: Type<ICommand>): CommandMetadata => {
	return Reflect.getMetadata(COMMAND_METADATA, command) ?? {};
};
