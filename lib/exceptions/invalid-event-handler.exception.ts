export class InvalidEventHandlerException extends Error {
  constructor() {
    super(
      `Invalid event handler exception (missing @EventsHandler() decorator?)`,
    );
  }
}
