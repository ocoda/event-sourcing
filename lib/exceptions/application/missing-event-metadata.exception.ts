export class MissingEventMetadataException extends Error {
  constructor(event: Function) {
    super(
      `Missing event metadata exception for ${event.constructor} (missing @EventName() decorator?)`,
    );
  }
}
