export class MissingQueryMetadataException extends Error {
	constructor(query: Function) {
		super(`Missing query metadata exception for ${query.constructor}`);
	}
}
