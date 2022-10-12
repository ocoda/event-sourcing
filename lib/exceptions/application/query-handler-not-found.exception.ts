export class QueryHandlerNotFoundException extends Error {
	constructor(query: Function) {
		super(`The query handler for the "${query.name}" query was not found`);
	}
}
