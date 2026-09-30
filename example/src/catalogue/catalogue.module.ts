import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { Controllers, Events, Providers } from './catalogue.providers.js';

@Module({
	imports: [EventSourcingModule.forFeature({ events: Events })],
	providers: Providers,
	controllers: Controllers,
})
export class CatalogueModule {}
