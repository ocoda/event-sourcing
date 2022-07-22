import { Injectable, OnApplicationBootstrap, Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Injector } from '@nestjs/core/injector/injector';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { CommandBus, CommandHandlerType } from './command-bus';
import {
  COMMAND_HANDLER_METADATA,
  COMMAND_METADATA,
} from './decorators/constants';
import { InvalidCommandHandlerException } from './exceptions';
import { CommandMetadata, ICommand, ICommandHandler } from './interfaces';

@Injectable()
export class CommandHandlersLoader implements OnApplicationBootstrap {
  private readonly injector = new Injector();

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly commandBus: CommandBus,
  ) {}

  onApplicationBootstrap() {
    this.loadCommandHandlers();
  }

  loadCommandHandlers() {
    const providers = this.discoveryService.getProviders();

    const handlers: InstanceWrapper[] = providers.filter(
      ({ metatype }) =>
        metatype && Reflect.hasMetadata(COMMAND_HANDLER_METADATA, metatype),
    );

    handlers.forEach(({ metatype, instance }) => {
      const command: CommandHandlerType = Reflect.getMetadata(
        COMMAND_HANDLER_METADATA,
        metatype,
      );

      const { id }: CommandMetadata = Reflect.getMetadata(
        COMMAND_METADATA,
        command,
      );

      if (!id) {
        throw new InvalidCommandHandlerException();
      }

      this.commandBus.bind(instance, id);
    });
  }
}
