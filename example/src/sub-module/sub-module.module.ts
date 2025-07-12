import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';

import { CommandHandlers, Controller, Events } from './sub-module.providers';

@Module({
	imports: [
		EventSourcingModule.forFeature({
			events: [...Events],
		}),
	],
	controllers: [...Controller],
	providers: [...CommandHandlers],
	exports: [],
})
export class SubModuleModule {}
