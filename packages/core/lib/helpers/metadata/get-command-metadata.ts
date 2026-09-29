import type { Type } from '@nestjs/common';
import { COMMAND_METADATA } from '../../decorators/index.js';
import type { CommandMetadata, ICommand } from '../../interfaces/index.js';

/**
 * @deprecated The `CommandBus` keys its handlers by class and no longer reads this metadata. Removed in 5.0.
 */
export const getCommandMetadata = (command: Type<ICommand>): CommandMetadata => {
	return Reflect.getMetadata(COMMAND_METADATA, command) ?? {};
};
