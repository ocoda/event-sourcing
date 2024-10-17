import {
	CommandHandler,
	type ICommand,
	type ICommandHandler,
	getCommandHandlerMetadata,
	getCommandMetadata,
} from '@ocoda/event-sourcing';

describe('@CommandHandler', () => {
	class TestCommand implements ICommand {}

	@CommandHandler(TestCommand)
	class TestCommandHandler implements ICommandHandler {
		async execute() {}
	}

	it('should specify which command the command-handler handles', () => {
		const { command } = getCommandHandlerMetadata(TestCommandHandler);
		expect(command).toEqual(TestCommand);

		const { id } = getCommandMetadata(command);
		expect(id).toBeDefined();
	});
});
