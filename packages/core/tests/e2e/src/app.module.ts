import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';
import { InMemoryEventStore, InMemorySnapshotStore } from '@ocoda/event-sourcing/integration';

@Module({
	imports: [
		EventSourcingModule.forRoot({
			events: [...Events],
			eventStore: {
				driver: InMemoryEventStore,
				useDefaultPool: false,
			},
			snapshotStore: {
				driver: InMemorySnapshotStore,
				useDefaultPool: false,
			},
		}),
	],
	providers: testProviders,
})
export class AppModule {}
