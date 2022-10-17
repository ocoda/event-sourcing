export class MissingSagaMetadataException extends Error {
	constructor(saga: Function) {
		super(`Missing saga metadata exception for ${saga.name}`);
	}
}
