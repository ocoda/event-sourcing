import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { CatalogueModule, LoaningModule } from '@ocoda/event-sourcing-testing/e2e';
import { InMemoryEventStore, InMemorySnapshotStore } from '@ocoda/event-sourcing/integration';

@Module({
	imports: [
		EventSourcingModule.forRoot({
			eventStore: {
				driver: InMemoryEventStore,
				useDefaultPool: false,
			},
			snapshotStore: {
				driver: InMemorySnapshotStore,
				useDefaultPool: false,
			},
		}),
		CatalogueModule,
		LoaningModule,
	],
})
export class AppModule {}
