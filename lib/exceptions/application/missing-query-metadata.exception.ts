export class MissingQueryMetadataException extends Error {
	constructor(query: { name: string }) {
		super(`Missing query metadata exception for ${query.name}`);
	}
}
