import { Module } from '@nestjs/common';
import { EventLogController } from './event-log.controller.js';
import { LoggingEventPublisher } from './logging.event-publisher.js';

@Module({
	providers: [LoggingEventPublisher],
	controllers: [EventLogController],
})
export class EventLogModule {}
