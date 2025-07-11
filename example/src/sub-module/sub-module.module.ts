import {Module} from "@nestjs/common";
import {EventSourcingModule} from "@ocoda/event-sourcing";

import {
    Events,
    Controller,
    CommandHandlers
} from "./sub-module.providers";

@Module({
    imports: [
        EventSourcingModule.forFeature({
            events : [
                ...Events
            ]
        })
    ],
    controllers: [
        ...Controller
    ],
    providers: [
        ...CommandHandlers
    ],
    exports: []
})
export class SubModuleModule {

}