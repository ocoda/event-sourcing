import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';

import { BlogEntry, BlogEntryAuthorId } from '../../domain/models';

export class CreateBlogEntryCommand implements ICommand {
	constructor(
		public readonly autor: string,
		public readonly title?: string,
		public readonly content?: string,
		public readonly createdAt: Date = new Date(),
	) {}
}

@CommandHandler(CreateBlogEntryCommand)
export class CreateBlogEntryCommandHandler implements ICommandHandler {
	async execute(command: CreateBlogEntryCommand): Promise<string> {
		const blogEntry = new BlogEntry();

		// create
		return blogEntry.create(BlogEntryAuthorId.from(command.autor), command.title, command.content, command.createdAt)
			.value;
	}
}
