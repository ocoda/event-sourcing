import type { Type } from '@nestjs/common';
import type { ICommand } from './command.interface.js';

export interface CommandHandlerMetadata {
	command: Type<ICommand>;
}
