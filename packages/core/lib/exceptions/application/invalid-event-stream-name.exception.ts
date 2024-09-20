export class InvalidEventStreamNameError extends Error {
	public static becauseExceedsMaxLength(target: string, maxLength: number): InvalidEventStreamNameError {
		return new InvalidEventStreamNameError(
			`Stream name for event '${target}' exceeds the maximum length of ${maxLength} characters.`,
		);
	}
}
