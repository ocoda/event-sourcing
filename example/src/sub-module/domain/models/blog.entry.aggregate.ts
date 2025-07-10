import { Aggregate, AggregateRoot, EventHandler, UUID} from '@ocoda/event-sourcing';
import {
    BlogEntryCreatedEvent,
    BlogEntryDeletedEvent
} from '../events';
import { } from '../exceptions';

export class BlogEntryId extends UUID {}
export class BlogEntryAuthorId extends UUID {}

@Aggregate({ streamName: 'blog-entry' })
export class BlogEntry extends AggregateRoot {
    private _id: BlogEntryId;
    private _authorId: BlogEntryAuthorId;
    private _content:string = '';
    private _title:string = '';
    private _createdAt:Date|null = null;

    get id(){ return this._id; }
    get authorId(){ return this._authorId; }
    get content(){ return this._content; }
    get title(){ return this._title; }
    get createdAt(){ return this._createdAt; }

    create(author: BlogEntryAuthorId, title: string, content: string, createdOn?:Date){
        // validate the stuff
        if(!author || !author.value)
            throw new Error('Author is required');

        if(!title)
            throw new Error('Title is required');

        // generate the id
        const id = BlogEntryId.generate();

        // set the created on
        createdOn ??= new Date();

        this.applyEvent<BlogEntryCreatedEvent>(
            new BlogEntryCreatedEvent(
                id.value, title, content, author.value, createdOn
            )
        )
    }
    delete() {
        this.applyEvent(
            new BlogEntryDeletedEvent(this.id.value)
        )
    }

    // @NewEventHandler(BlogEntryCreatedEvent)
    @EventHandler(BlogEntryCreatedEvent)
    public onCreated(event: BlogEntryCreatedEvent) {
        this._id = BlogEntryId.from(event.id);
        this._authorId = BlogEntryAuthorId.from(event.authorId);
        this._title = event.title;
        this._content = event.content;
        this._createdAt = event.createdAt
    }

    @EventHandler(BlogEntryDeletedEvent)
    onDeleted(event: BlogEntryDeletedEvent) {
        // todo delete logic
    }
}
