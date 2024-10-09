export class InvalidAggregateStreamNameException extends Error {
	public static becauseExceedsMaxLength(target: string, maxLength: number): InvalidAggregateStreamNameException {
		return new InvalidAggregateStreamNameException(
			`Stream name for aggregate '${target}' exceeds the maximum length of ${maxLength} characters.`,
		);
	}
}
