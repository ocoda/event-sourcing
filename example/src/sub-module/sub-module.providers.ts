import {
    BlogEntryDeletedEvent,
    BlogEntryCreatedEvent
} from './domain/events'

import {
    BlogEntryController
} from './application/controller'
import {
    CreateBlogEntryCommandHandler
} from './application/commands'

export const Events = [
    BlogEntryCreatedEvent,
    BlogEntryDeletedEvent
]
export const Controller = [
    BlogEntryController
];
export const CommandHandlers = [
    CreateBlogEntryCommandHandler
];