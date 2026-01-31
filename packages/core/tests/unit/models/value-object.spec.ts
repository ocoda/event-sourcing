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
