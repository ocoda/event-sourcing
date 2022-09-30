import { CommandType } from '../../command-bus';

export interface CommandHandlerMetadata {
	command: CommandType;
}
