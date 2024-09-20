export class InvalidAggregateStreamNameError extends Error {
	public static becauseExceedsMaxLength(target: string, maxLength: number): InvalidAggregateStreamNameError {
		return new InvalidAggregateStreamNameError(
			`Stream name for aggregate '${target}' exceeds the maximum length of ${maxLength} characters.`,
		);
	}
}
