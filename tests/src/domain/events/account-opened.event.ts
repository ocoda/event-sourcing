import { EventName, IEvent } from '@ocoda/event-sourcing';

@EventName('account-opened')
export class AccountOpenedEvent implements IEvent {
  constructor(
    public readonly accountId: string,
    public readonly accountOwnerIds?: string[],
  ) {}
}
