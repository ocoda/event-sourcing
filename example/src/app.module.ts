import { Module, OnModuleInit } from '@nestjs/common';
import { EventSourcingModule, EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	EventHandlers,
	EventPublishers,
	Events,
	QueryHandlers,
	SnapshotHandlers,
} from './app.providers';
import { AccountController } from './application/account.controller';

@Module({
	imports: [
		EventSourcingModule.forRootAsync({
			useFactory: () => ({
				events: [...Events],
				eventStore: {
					client: 'dynamodb',
					options: {
						region: 'us-east-1',
						endpoint: 'http://127.0.0.1:8000',
						credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
					},
				},
				snapshotStore: {
					client: 'dynamodb',
					options: {
						region: 'us-east-1',
						endpoint: 'http://127.0.0.1:8000',
						credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
					},
				},
			}),
		}),
	],
	providers: [
		...AggregateRepositories,
		...CommandHandlers,
		...QueryHandlers,
		...SnapshotHandlers,
		...EventHandlers,
		...EventPublishers,
	],
	controllers: [AccountController],
})
export class AppModule implements OnModuleInit {
	constructor(
		private readonly eventStore: EventStore,
		private readonly snapshotStore: SnapshotStore,
	) {}

	onModuleInit() {
		this.eventStore.setup();
		this.snapshotStore.setup();
	}
}
