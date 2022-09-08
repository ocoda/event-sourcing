import { CommandHandler, COMMAND_HANDLER_METADATA, COMMAND_METADATA, ICommand } from '../../../lib';

describe('@CommandHandler', () => {
	class TestCommand implements ICommand {}

	@CommandHandler(TestCommand)
	class TestCommandHandler {}

	it('should specify which command the command-handler handles', () => {
		const command: ICommand = Reflect.getMetadata(COMMAND_HANDLER_METADATA, TestCommandHandler);
		expect(command).toEqual(TestCommand);

		const commandMetadata = Reflect.getMetadata(COMMAND_METADATA, command);
		expect(commandMetadata.id).toBeDefined();
	});
});
