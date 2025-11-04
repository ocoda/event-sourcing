import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { bootstrap } from './bootstrap';
import { CatalogueModule } from '@ocoda/event-sourcing-example/catalogue/catalogue.module';
import { LoaningModule } from '@ocoda/event-sourcing-example/loaning/loaning.module';

@Module({
	imports: [EventSourcingModule.forRoot({}), CatalogueModule, LoaningModule],
})
class AppModule {}

bootstrap(AppModule);
