import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
// On SIGTERM or SIGINT, wait for the running publishers and subscribers, then disconnect the stores.
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT) || 3000);
