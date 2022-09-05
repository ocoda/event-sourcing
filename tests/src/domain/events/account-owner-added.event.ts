import { EventName, IEvent } from '@ocoda/event-sourcing';

@EventName('account-owner-added')
export class AccountOwnerAddedEvent implements IEvent {
  constructor(public readonly accountOwnerId: string) {}
}
