import { CommandHandlerType } from '../command-bus';
import { COMMAND_METADATA } from '../decorators';
import { MissingCommandMetadataException } from '../exceptions';
import { CommandMetadata } from '../interfaces';

export const getCommandMetadata = (command: CommandHandlerType): CommandMetadata => {
	const metadata = Reflect.getMetadata(COMMAND_METADATA, command);
	if (!metadata) {
		throw new MissingCommandMetadataException(command);
	}
	return metadata;
};
