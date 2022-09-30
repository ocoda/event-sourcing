export class MissingQueryHandlerMetadataException extends Error {
	constructor(queryHandler: Function) {
		super(
			`Missing query-handler metadata exception for ${queryHandler.constructor} (missing @QueryHandler() decorator?)`,
		);
	}
}
