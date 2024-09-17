export class QueryHandlerNotFoundException extends Error {
	constructor(query: { name: string }) {
		super(`The query handler for the '${query.name}' query was not found`);
	}
}
