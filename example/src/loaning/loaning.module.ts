import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { Controllers, Events, Providers } from './loaning.providers.js';

@Module({
	imports: [EventSourcingModule.forFeature({ events: Events })],
	providers: Providers,
	controllers: Controllers,
})
export class LoaningModule {}
