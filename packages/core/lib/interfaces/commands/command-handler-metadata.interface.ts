import { Type } from '@nestjs/common';
import { ICommand } from './command.interface';

export interface CommandHandlerMetadata {
	command: Type<ICommand>;
}
