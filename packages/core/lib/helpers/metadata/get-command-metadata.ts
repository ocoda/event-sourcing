import type { Type } from '@nestjs/common';
import { COMMAND_METADATA } from '../../decorators/index.js';
import type { CommandMetadata, ICommand } from '../../interfaces/index.js';

export const getCommandMetadata = (command: Type<ICommand>): CommandMetadata => {
	return Reflect.getMetadata(COMMAND_METADATA, command) ?? {};
};
