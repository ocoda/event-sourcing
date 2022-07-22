// import {
//   Injectable,
//   OnApplicationBootstrap,
//   OnApplicationShutdown,
// } from '@nestjs/common';
// import {
//   ContextIdFactory,
//   DiscoveryService,
//   MetadataScanner,
//   ModuleRef,
// } from '@nestjs/core';
// import { Injector } from '@nestjs/core/injector/injector';
// import {
//   ContextId,
//   InstanceWrapper,
// } from '@nestjs/core/injector/instance-wrapper';
// import { Module } from '@nestjs/core/injector/module';
// import { CommandHandlersMetadataAccessor } from './command-handler-metadata.accessor';

// @Injectable()
// export class CommandHandlersLoader implements OnApplicationBootstrap {
//   private readonly injector = new Injector();

//   constructor(
//     private readonly discoveryService: DiscoveryService,
//     private readonly metadataAccessor: CommandHandlersMetadataAccessor,
//     private readonly metadataScanner: MetadataScanner,
//     private readonly moduleRef: ModuleRef,
//   ) {}

//   onApplicationBootstrap() {
//     this.loadCommandHandlers();
//   }

//   loadCommandHandlers() {
//     const providers = this.discoveryService.getProviders();
//     providers
//       .filter((wrapper) => wrapper.instance)
//       .forEach((wrapper: InstanceWrapper) => {
//         const { instance } = wrapper;
//         const prototype = Object.getPrototypeOf(instance) || {};
//         const isRequestScoped = !wrapper.isDependencyTreeStatic();
//         this.metadataScanner.scanFromPrototype(
//           instance,
//           prototype,
//           (methodKey: string) =>
//             this.subscribeToCommandIfHandler(
//               instance,
//               methodKey,
//               isRequestScoped,
//               wrapper.host as Module,
//             ),
//         );
//       });
//   }

//   private subscribeToCommandIfHandler(
//     instance: Record<string, any>,
//     methodKey: string,
//     isRequestScoped: boolean,
//     moduleRef: Module,
//   ) {
//     const commandHandlerMetadata =
//       this.metadataAccessor.getEventHandlerMetadata(instance[methodKey]);
//     if (!commandHandlerMetadata) {
//       return;
//     }

//     const handler = commandHandlerMetadata;
//     const listenerMethod = this.getRegisterListenerMethodBasedOn(options);

//     if (isRequestScoped) {
//       this.registerRequestScopedListener({
//         event,
//         eventListenerInstance: instance,
//         listenerMethod,
//         listenerMethodKey: methodKey,
//         moduleRef,
//         options,
//       });
//     } else {
//       listenerMethod(
//         event,
//         (...args: unknown[]) => instance[methodKey].call(instance, ...args),
//         options,
//       );
//     }
//   }
// }
