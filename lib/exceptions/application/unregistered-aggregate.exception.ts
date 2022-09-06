export class UnregisteredAggregateException extends Error {
	constructor(aggregate: string) {
		super(`Aggregate '${aggregate}' is not registered. Register it in the EventSourcingModule.`);
	}
}
