import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
	CommandBus,
	CommandHandlerNotFoundException,
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
} from '@ocoda/event-sourcing';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from '@ocoda/event-sourcing/decorators';

describe(CommandBus, () => {
	class CommandWithoutMetadata {}
	class CommandWithMetadata {}

	class CommandHandlerWithoutMetadata {
		execute() {
			return 'ok';
		}
	}

	class CommandHandlerWithMetadata {
		execute() {
			return 'ok';
		}
	}

	class CommandHandlerMissingCommandMetadata {
		execute() {
			return 'ok';
		}
	}

	class CommandHandlerForCommandWithMetadata {
		execute() {
			return 'ok';
		}
	}

	beforeAll(() => {
		Reflect.defineMetadata(COMMAND_METADATA, { id: 'command-with-metadata' }, CommandWithMetadata);
	});

	it('throws when executing a command without handler', () => {
		const bus = new CommandBus();
		class CommandWithMetadataOnly {}
		Reflect.defineMetadata(COMMAND_METADATA, { id: 'command-with-handler' }, CommandWithMetadataOnly);
		const command = new (CommandWithMetadataOnly as any)();

		expect(() => bus.execute(command)).toThrow(CommandHandlerNotFoundException);
	});

	it('throws when command metadata is missing', () => {
		const bus = new CommandBus();
		const command = new (CommandWithoutMetadata as any)();

		expect(() => bus.execute(command)).toThrow(MissingCommandMetadataException);
	});

	it('throws when registering a handler without instance', () => {
		const bus = new CommandBus();
		const wrapper = { metatype: CommandHandlerWithMetadata, instance: undefined } as unknown as InstanceWrapper;

		expect(() => bus.register([wrapper])).toThrow(TypeError);
	});

	it('throws when registering a handler without handler metadata', () => {
		const bus = new CommandBus();
		const wrapper = {
			metatype: CommandHandlerWithoutMetadata,
			instance: new CommandHandlerWithoutMetadata(),
		} as unknown as InstanceWrapper;

		expect(() => bus.register([wrapper])).toThrow(MissingCommandHandlerMetadataException);
	});

	it('throws when registering handler for command without metadata', () => {
		const bus = new CommandBus();
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command: CommandWithoutMetadata }, CommandHandlerWithMetadata);
		const wrapper = {
			metatype: CommandHandlerWithMetadata,
			instance: new CommandHandlerWithMetadata(),
		} as unknown as InstanceWrapper;

		expect(() => bus.register([wrapper])).toThrow(MissingCommandMetadataException);
	});

	it('registers a handler with metadata', () => {
		const bus = new CommandBus();
		Reflect.defineMetadata(
			COMMAND_HANDLER_METADATA,
			{ command: CommandWithMetadata },
			CommandHandlerForCommandWithMetadata,
		);
		const wrapper = {
			metatype: CommandHandlerForCommandWithMetadata,
			instance: new CommandHandlerForCommandWithMetadata(),
		} as unknown as InstanceWrapper;

		bus.register([wrapper]);

		expect((bus as any).handlers.has('command-with-metadata')).toBe(true);
	});
});
