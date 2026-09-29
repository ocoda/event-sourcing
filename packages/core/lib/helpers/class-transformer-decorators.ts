/**
 * Internal, not exported from the package: finds the class-transformer decorators of a class, so that the default
 * `JsonEventSerializer` never drops their effect silently (ADR 0001 §6). The bootstrap refuses an event class with
 * decorators, and the serializer refuses an event that holds an instance of a class whose decorators would have shaped
 * the payload that 3.x stored.
 */

/**
 * class-transformer's metadata storage. The CommonJS build is the one Node loads for `import 'class-transformer'`
 * (the package has no exports map), so decorators applied through it are found. A bundler that resolves the `module`
 * build creates a second storage, which this check can't see: it is best-effort.
 */
const STORAGE_MODULE = 'class-transformer/cjs/storage.js';

/**
 * The maps of class-transformer 0.5's `MetadataStorage`: target class → property name (`undefined` for the class) →
 * metadata (an array of them for `@Transform`).
 */
const DECORATOR_MAPS = [
	['_typeMetadatas', '@Type'],
	['_transformMetadatas', '@Transform'],
	['_exposeMetadatas', '@Expose'],
	['_excludeMetadatas', '@Exclude'],
] as const;

type MetadataField = (typeof DECORATOR_MAPS)[number][0];

type MetadataStorage = Record<MetadataField, Map<unknown, Map<unknown, unknown>>>;

interface DecoratorOptions {
	toClassOnly?: boolean;
	toPlainOnly?: boolean;
	discriminator?: { property?: string; subTypes?: unknown[] };
}

/**
 * Which decorators to report:
 * - `'all'`: every decorator, for an event class. class-transformer applies them when it serializes the event and
 *   when it reads it back.
 * - `'serialize'`: those that change what class-transformer's `instanceToPlain` returns for an instance of the class,
 *   for a class nested in an event. 3.x applied them when it stored the event, but not when it read it back: without a
 *   `@Type` on the event, which the bootstrap refuses, it doesn't know the nested class. So `@Type` counts only with a
 *   discriminator (it adds the discriminator property), a class-level `@Expose` doesn't count (it only selects the
 *   default strategy), and an `@Exclude` or `@Transform` for `toClassOnly` doesn't either.
 */
export type ClassTransformerDecoratorScope = 'all' | 'serialize';

/** Returns the class-transformer decorators of a class and its parent classes, such as `@Type on Deposited.amount`. */
export type ClassTransformerDecoratorsOf = (target: Function, scope?: ClassTransformerDecoratorScope) => string[];

const isMetadataStorage = (storage: unknown): storage is MetadataStorage =>
	typeof storage === 'object' &&
	storage !== null &&
	DECORATOR_MAPS.every(([field]) => (storage as Record<string, unknown>)[field] instanceof Map);

const lineageOf = (target: Function): Function[] => {
	const lineage: Function[] = [];
	for (let cls: unknown = target; typeof cls === 'function' && cls !== Function.prototype;) {
		lineage.push(cls as Function);
		cls = Object.getPrototypeOf(cls);
	}
	return lineage;
};

const toClassOnly = (metadata: unknown): boolean => {
	const options = (metadata as { options?: DecoratorOptions } | undefined)?.options;
	return options?.toClassOnly === true && options.toPlainOnly !== true;
};

/** Whether a decorator changes what `instanceToPlain` returns for an instance of the class (scope `'serialize'`). */
const shapesPlain = (field: MetadataField, property: unknown, metadata: unknown): boolean => {
	switch (field) {
		case '_typeMetadatas': {
			const discriminator = (metadata as { options?: DecoratorOptions } | undefined)?.options?.discriminator;
			return Boolean(discriminator?.property && discriminator.subTypes);
		}
		case '_transformMetadatas':
			return !Array.isArray(metadata) || metadata.some((transform) => !toClassOnly(transform));
		case '_exposeMetadatas':
			return property !== undefined;
		case '_excludeMetadatas':
			return property === undefined || !toClassOnly(metadata);
	}
};

const decoratorsIn = (storage: MetadataStorage, target: Function, scope: ClassTransformerDecoratorScope): string[] =>
	lineageOf(target).flatMap((cls) =>
		DECORATOR_MAPS.flatMap(([field, decorator]) =>
			[...(storage[field].get(cls) ?? new Map<unknown, unknown>())]
				.filter(([property, metadata]) => scope === 'all' || shapesPlain(field, property, metadata))
				.map(([property]) =>
					property === undefined ? `${decorator} on ${cls.name}` : `${decorator} on ${cls.name}.${String(property)}`,
				),
		),
	);

/**
 * Loads class-transformer's metadata storage. Resolves to `undefined` when class-transformer can't be loaded (it is an
 * optional peer dependency: without it, no class can carry its decorators) or its storage has an unknown shape.
 *
 * The lookup caches its `'serialize'` results per class: the JSON serializer runs it for every class instance it meets.
 *
 * @param load imports a module; replaced in tests.
 */
export const loadClassTransformerDecorators = async (
	load: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<ClassTransformerDecoratorsOf | undefined> => {
	let storage: unknown;
	try {
		const module = (await load(STORAGE_MODULE)) as { defaultMetadataStorage?: unknown } | undefined;
		storage = module?.defaultMetadataStorage;
	} catch {
		return undefined;
	}
	if (!isMetadataStorage(storage)) {
		return undefined;
	}
	const serializing = new WeakMap<Function, string[]>();
	return (target, scope = 'all') => {
		if (scope === 'all') {
			return decoratorsIn(storage, target, scope);
		}
		let found = serializing.get(target);
		if (!found) {
			found = decoratorsIn(storage, target, scope);
			serializing.set(target, found);
		}
		return found;
	};
};

/**
 * The token of the lookup that `loadClassTransformerDecorators()` resolves to (`undefined` without class-transformer).
 * An async factory provider loads it while Nest instantiates the module, so it is ready before any lifecycle hook and
 * any first use registers the events.
 */
export const CLASS_TRANSFORMER_DECORATORS = Symbol('ClassTransformerDecorators');

export const classTransformerDecoratorsProvider = {
	provide: CLASS_TRANSFORMER_DECORATORS,
	useFactory: (): Promise<ClassTransformerDecoratorsOf | undefined> => loadClassTransformerDecorators(),
};

const nestedClassChecks = new WeakMap<object, ClassTransformerDecoratorsOf>();

/**
 * Makes a `JsonEventSerializer` that the registration gave an event by default refuse to serialize an event that
 * holds an instance of a class with class-transformer decorators of scope `'serialize'`.
 */
export const checkNestedClasses = (serializer: object, decoratorsOf: ClassTransformerDecoratorsOf): void => {
	nestedClassChecks.set(serializer, decoratorsOf);
};

/** The lookup that `checkNestedClasses()` gave the serializer, if any. */
export const nestedClassCheckOf = (serializer: object): ClassTransformerDecoratorsOf | undefined =>
	nestedClassChecks.get(serializer);
