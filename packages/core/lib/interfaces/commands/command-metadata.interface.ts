/**
 * The id that `@CommandHandler()` stores on a command class.
 *
 * @deprecated The `CommandBus` keys its handlers by class and no longer reads it. Removed in 5.0.
 */
export interface CommandMetadata {
	id: string;
}
