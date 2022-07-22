import { Injectable, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COMMAND_HANDLER_METADATA } from './decorators/constants';
import { ICommandHandler } from './interfaces';

@Injectable()
export class CommandHandlersMetadataAccessor {
  constructor(private readonly reflector: Reflector) {}

  getEventHandlerMetadata(
    target: Type<unknown>,
  ): Type<ICommandHandler> | undefined {
    return this.reflector.get(COMMAND_HANDLER_METADATA, target);
  }
}
