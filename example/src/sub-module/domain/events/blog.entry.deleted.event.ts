import {Event, IEvent} from "@ocoda/event-sourcing";

@Event("blog-entry-deleted")
export class BlogEntryDeletedEvent implements IEvent {
    constructor(
        public readonly id: string
    ) {}
}