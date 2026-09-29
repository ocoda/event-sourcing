interface ValueObjectProps {
	[index: string]: any;
}

export abstract class ValueObject<T extends ValueObjectProps = ValueObjectProps> {
	public readonly props: T;

	protected constructor(props: T) {
		this.props = Object.freeze(props);
	}

	/**
	 * Tells whether another value object is of the same class and has the same props (compared with `===`).
	 * Value objects of different classes are never equal, even with the same props, and `null` or `undefined` is never
	 * equal to a value object.
	 */
	public equals(other: ValueObject<T> | null | undefined): boolean {
		if (other === null || other === undefined) {
			return false;
		}
		if (other === this) {
			return true;
		}
		if (this.constructor !== other.constructor) {
			return false;
		}

		const keys = Object.keys(this.props);
		return (
			keys.length === Object.keys(other.props).length &&
			keys.every((key) => Object.hasOwn(other.props, key) && this.props[key] === other.props[key])
		);
	}
}
