import {Body, Controller, Post} from '@nestjs/common';
import {CommandBus, QueryBus} from "@ocoda/event-sourcing";
import {CreateBlogEntryCommand} from "../commands";

@Controller('blog-entry')
export class BlogEntryController {
    constructor(
        private readonly commandBus: CommandBus,
        private readonly queryBus: QueryBus,
    ) {}

    @Post('create')
    async create(
        @Body('author') author: string,
        @Body('title') title?: string,
        @Body('content') content?: string
    ): Promise<{ id: string }> {

        const id = await this.commandBus.execute<CreateBlogEntryCommand, string>(
            new CreateBlogEntryCommand(author, title, content)
        );

        return { id };
    }

}