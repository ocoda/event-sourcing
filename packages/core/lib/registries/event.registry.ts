import {Type} from "@angular/core";
import {IEvent} from "../interfaces";

export class EventRegistry
{
    private static readonly events: Type<IEvent>[] = [];

    public static register(...event: Type<IEvent>[]): void {
        // add events to the registry
        this.events.push(...event);
    }
    public static getEvents(): Type<IEvent>[] {
        // return the registered events
        return this.events;
    }
}