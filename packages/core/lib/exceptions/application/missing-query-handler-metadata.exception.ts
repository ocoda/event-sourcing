export class MissingQueryHandlerMetadataException extends Error {
	constructor(queryHandler: { name: string }) {
		super(`Missing query-handler metadata exception for ${queryHandler.name} (missing @QueryHandler() decorator?)`);
	}
}
