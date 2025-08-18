import { ValueObject } from '@ocoda/event-sourcing';
import { InvalidIsbnException } from '../../exceptions/invalid-isbn.exception';

export class Isbn extends ValueObject<{ value: string }> {
	private constructor(value: string) {
		super({ value });
	}

	public static from(isbn: string): Isbn {
		if (!isbn) {
			throw InvalidIsbnException.becauseEmpty();
		}

		const normalizedIsbn = isbn.replace(/[-\s]/g, '').toUpperCase();

		if (!Isbn.isValid(normalizedIsbn)) {
			throw InvalidIsbnException.becauseInvalid(isbn);
		}

		return new Isbn(normalizedIsbn);
	}

	static isValid(isbn: string): boolean {
		return Isbn.isValidIsbn10(isbn) || Isbn.isValidIsbn13(isbn);
	}

	static isValidIsbn10(isbn: string): boolean {
		if (!/^\d{9}[\dX]$/.test(isbn)) return false;

		let sum = 0;
		for (let i = 0; i < 9; i++) {
			sum += (i + 1) * Number.parseInt(isbn[i], 10);
		}

		const check = isbn[9] === 'X' ? 10 : Number.parseInt(isbn[9], 10);
		sum += 10 * check;

		return sum % 11 === 0;
	}

	static isValidIsbn13(isbn: string): boolean {
		if (!/^\d{13}$/.test(isbn)) return false;

		let sum = 0;
		for (let i = 0; i < 12; i++) {
			const digit = Number.parseInt(isbn[i], 10);
			sum += digit * (i % 2 === 0 ? 1 : 3);
		}

		const checkDigit = (10 - (sum % 10)) % 10;
		return checkDigit === Number.parseInt(isbn[12], 10);
	}

	get value(): string {
		return this.props.value;
	}
}
