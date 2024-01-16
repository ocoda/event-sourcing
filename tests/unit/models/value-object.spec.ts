import { ValueObject } from '../../../lib';

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
});
