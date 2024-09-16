export interface DynamoEventEntity {
	streamId: string;
	version: number;
	event: string;
	payload: any;
	eventId: string;
	aggregateId: string;
	occurredOn: number;
	correlationId?: string;
	causationId?: string;
}
