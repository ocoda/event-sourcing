export class UnregisteredEventException extends Error {
  constructor(event: string) {
    super(
      `Event '${event}' is not registered. Register it in the EventSourcingModule.`,
    );
  }
}
