import { ValueObject } from '@ocoda/event-sourcing';

describe(ValueObject, () => {
	class Point extends ValueObject<{ x: number; y: number }> {
		protected constructor(x: number, y: number) {
			super({ x, y });
		}

		public static from(x: number, y: number): Point {
			return new Point(x, y);
		}

		get x(): number {
			return this.props.x;
		}

		get y(): number {
			return this.props.y;
		}
	}

	it('should generate a value object', () => {
		const point = Point.from(2.5, 6.3);
		expect(point.x).toBe(2.5);
		expect(point.y).toBe(6.3);
	});

	it('should validate if value objects are equal', () => {
		const point1 = Point.from(2.5, 6.3);
		const point2 = Point.from(2.5, 6.3);

		expect(point1.equals(point2)).toBe(true);
	});

	it('is never equal to null or undefined', () => {
		const point = Point.from(2.5, 6.3);

		expect(point.equals(null)).toBe(false);
		expect(point.equals(undefined)).toBe(false);
	});

	it('is equal to itself', () => {
		const point = Point.from(2.5, 6.3);

		expect(point.equals(point)).toBe(true);
	});

	it('compares the keys of the props, not only their number', () => {
		class Bag extends ValueObject<Record<string, unknown>> {
			protected constructor(props: Record<string, unknown>) {
				super(props);
			}

			static from(props: Record<string, unknown>) {
				return new Bag(props);
			}
		}

		expect(Bag.from({ a: undefined }).equals(Bag.from({ b: undefined }))).toBe(false);
		expect(Bag.from({ a: 1, b: 2 }).equals(Bag.from({ b: 2, a: 1 }))).toBe(true);
		expect(Bag.from({ a: 1 }).equals(Bag.from({ a: 1, b: 2 }))).toBe(false);
		expect(Bag.from({ a: 1 }).equals(Bag.from({ a: 2 }))).toBe(false);
	});

	it('returns false for different types', () => {
		class Size extends ValueObject<{ width: number }> {
			protected constructor(width: number) {
				super({ width });
			}

			static from(width: number) {
				return new Size(width);
			}
		}

		const point = Point.from(1, 2);
		const size = Size.from(1);

		expect(point.equals(size as any)).toBe(false);
	});
});
