import { EventName, IEvent } from '@ocoda/event-sourcing';

@EventName('account-owner-removed')
export class AccountOwnerRemovedEvent implements IEvent {
  constructor(public readonly accountOwnerId: string) {}
}
