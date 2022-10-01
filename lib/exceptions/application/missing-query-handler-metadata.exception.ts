export class MissingQueryHandlerMetadataException extends Error {
	constructor(queryHandler: Function) {
		super(`Missing query-handler metadata exception for ${queryHandler.name} (missing @QueryHandler() decorator?)`);
	}
}
