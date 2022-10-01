import { getCommandHandlerMetadata, getCommandMetadata } from '@ocoda/event-sourcing/helpers';
import { CommandHandler, ICommand } from '../../../lib';

describe('@CommandHandler', () => {
	class TestCommand implements ICommand {}

	@CommandHandler(TestCommand)
	class TestCommandHandler {}

	it('should specify which command the command-handler handles', () => {
		const { command } = getCommandHandlerMetadata(TestCommandHandler);
		expect(command).toEqual(TestCommand);

		const { id } = getCommandMetadata(command);
		expect(id).toBeDefined();
	});
});
