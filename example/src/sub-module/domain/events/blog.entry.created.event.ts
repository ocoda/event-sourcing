import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('blog-entry-created')
export class BlogEntryCreatedEvent implements IEvent {
	constructor(
		public readonly id: string,
		public readonly title: string,
		public readonly content: string,
		public readonly authorId: string,
		public readonly createdAt: Date,
	) {}
}
