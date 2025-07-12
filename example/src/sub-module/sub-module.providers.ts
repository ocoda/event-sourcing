import { BlogEntryCreatedEvent, BlogEntryDeletedEvent } from './domain/events';

import { CreateBlogEntryCommandHandler } from './application/commands';
import { BlogEntryController } from './application/controller';

export const Events = [BlogEntryCreatedEvent, BlogEntryDeletedEvent];
export const Controller = [BlogEntryController];
export const CommandHandlers = [CreateBlogEntryCommandHandler];
