import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as EventSourcing from '@ocoda/event-sourcing';
import { Event } from '@ocoda/event-sourcing';
import * as ClassTransformerEntry from '@ocoda/event-sourcing/class-transformer';
import { ClassTransformerEventSerializer } from '@ocoda/event-sourcing/class-transformer';
import { Exclude, Expose, Transform, Type, instanceToPlain, plainToInstance } from 'class-transformer';

class Money {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
	) {}
}

@Event('funds-deposited')
class FundsDeposited {
	@Type(() => Money)
	readonly amount: Money;

	@Type(() => Date)
	readonly bookedOn: Date;

	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value), { toClassOnly: true })
	readonly reference: string;

	@Exclude({ toPlainOnly: true })
	readonly secret?: string;

	@Expose({ name: 'channel' })
	readonly source: string;

	constructor(amount: Money, bookedOn: Date, reference: string, source: string, secret?: string) {
		this.amount = amount;
		this.bookedOn = bookedOn;
		this.reference = reference;
		this.source = source;
		this.secret = secret;
	}
}

describe(ClassTransformerEventSerializer, () => {
	const serializer = ClassTransformerEventSerializer.for(FundsDeposited);
	const bookedOn = new Date('2021-05-06T07:08:09.010Z');

	it('serializes and deserializes with the class-transformer decorators, like 3.x DefaultEventSerializer', () => {
		const event = new FundsDeposited(new Money(10, 'EUR'), bookedOn, 'ref-1', 'web', 'hidden');

		const payload = serializer.serialize(event);
		expect(payload).toStrictEqual(instanceToPlain(event));
		expect(payload).toMatchObject({ amount: { amount: 10, currency: 'EUR' }, channel: 'web' });
		expect(payload).not.toHaveProperty('secret');

		const stored = JSON.parse(JSON.stringify({ ...payload, reference: '  ref-1  ' }));
		const read = serializer.deserialize(stored);
		expect(read).toStrictEqual(plainToInstance(FundsDeposited, stored));
		expect(read).toBeInstanceOf(FundsDeposited);
		expect(read.amount).toBeInstanceOf(Money);
		expect(read.bookedOn).toStrictEqual(bookedOn);
		expect(read.reference).toBe('ref-1');
		expect(read.source).toBe('web');
	});

	it('is exported from the class-transformer entry point only', () => {
		expect(Object.keys(ClassTransformerEntry)).toEqual(['ClassTransformerEventSerializer']);
		expect(EventSourcing).not.toHaveProperty('ClassTransformerEventSerializer');
		// ADR 0001 §6: the 3.x default leaves the root entry, so code that used it chooses a serializer
		expect(EventSourcing).not.toHaveProperty('DefaultEventSerializer');
		expect(EventSourcing.JsonEventSerializer).toEqual(expect.any(Function));
	});

	it('keeps class-transformer out of every other entry point', () => {
		// class-transformer is an optional peer dependency: only the class-transformer entry point imports it statically.
		// The bootstrap check loads it with a dynamic import that tolerates its absence.
		const lib = resolve(import.meta.dirname, '../../../lib');
		const manifest = JSON.parse(readFileSync(resolve(lib, '../package.json'), 'utf8')) as {
			exports: Record<string, string | { import: string }>;
		};
		const packagesImportedBy = (entry: string): Set<string> => {
			const packages = new Set<string>();
			const seen = new Set<string>();
			const visit = (file: string) => {
				if (seen.has(file)) return;
				seen.add(file);
				const source = readFileSync(file, 'utf8');
				for (const [, specifier] of source.matchAll(/^(?:import|export)\s(?:[^;'"]*?\sfrom\s)?['"]([^'"]+)['"]/gm)) {
					if (specifier.startsWith('.')) {
						visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
					} else {
						packages.add(specifier);
					}
				}
			};
			visit(resolve(lib, entry));
			return packages;
		};

		// './dist/testing/index.js' is built from 'lib/testing/index.ts'
		const entries = Object.entries(manifest.exports)
			.filter(([subpath]) => subpath !== './package.json')
			.map(([subpath, target]) => {
				const file = typeof target === 'string' ? target : target.import;
				return [subpath, file.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts')] as const;
			});
		expect(entries).toContainEqual(['.', 'index.ts']);
		expect(entries).toContainEqual(['./class-transformer', 'class-transformer/index.ts']);

		const found = entries.map(([subpath, source]) => {
			const packages = packagesImportedBy(source);
			return { subpath, walked: packages.size > 0, classTransformer: packages.has('class-transformer') };
		});
		expect(found).toEqual(
			entries.map(([subpath]) => ({ subpath, walked: true, classTransformer: subpath === './class-transformer' })),
		);
	});
});
