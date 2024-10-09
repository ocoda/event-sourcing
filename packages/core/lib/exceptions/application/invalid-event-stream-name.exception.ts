export class InvalidEventStreamNameException extends Error {
	public static becauseExceedsMaxLength(target: string, maxLength: number): InvalidEventStreamNameException {
		return new InvalidEventStreamNameException(
			`Stream name for event '${target}' exceeds the maximum length of ${maxLength} characters.`,
		);
	}
}
