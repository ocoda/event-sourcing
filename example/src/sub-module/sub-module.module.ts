import {Module} from "@nestjs/common";
import {EventSourcingModule} from "@ocoda/event-sourcing";

import { Events } from "./sub-module.providers";

@Module({
    imports: [
        EventSourcingModule.forFeature({
            events : [
                ...Events
            ]
        })
    ],
    controllers: [],
    providers: [],
    exports: []
})
export class SubModuleModule {

}