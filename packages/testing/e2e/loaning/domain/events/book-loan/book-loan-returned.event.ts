import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-loan-returned')
export class BookLoanReturnedEvent implements IEvent {}
