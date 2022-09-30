import { CommandType } from '../command-bus';
import { COMMAND_METADATA } from '../decorators';
import { CommandMetadata } from '../interfaces';

export const getCommandMetadata = (command: CommandType): CommandMetadata => {
	return Reflect.getMetadata(COMMAND_METADATA, command) ?? {};
};
