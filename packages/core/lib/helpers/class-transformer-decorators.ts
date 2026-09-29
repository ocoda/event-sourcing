/**
 * Internal, not exported from the package: finds the class-transformer decorators of an event class, so that the
 * bootstrap can refuse an event that the default `JsonEventSerializer` would serialize without them (ADR 0001 §6).
 */

/**
 * class-transformer's metadata storage. The CommonJS build is the one Node loads for `import 'class-transformer'`
 * (the package has no exports map), so decorators applied through it are found. A bundler that resolves the `module`
 * build creates a second storage, which this check can't see: it is best-effort.
 */
const STORAGE_MODULE = 'class-transformer/cjs/storage.js';

/** The maps of class-transformer 0.5's `MetadataStorage`: target class → property name (`undefined` for the class). */
const DECORATOR_MAPS = [
	['_typeMetadatas', '@Type'],
	['_transformMetadatas', '@Transform'],
	['_exposeMetadatas', '@Expose'],
	['_excludeMetadatas', '@Exclude'],
] as const;

type MetadataStorage = Record<(typeof DECORATOR_MAPS)[number][0], Map<unknown, Map<unknown, unknown>>>;

/** Returns the class-transformer decorators of a class and its parent classes, such as `@Type on Deposited.amount`. */
export type ClassTransformerDecoratorsOf = (target: Function) => string[];

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

const decoratorsIn = (storage: MetadataStorage, target: Function): string[] =>
	lineageOf(target).flatMap((cls) =>
		DECORATOR_MAPS.flatMap(([field, decorator]) =>
			[...(storage[field].get(cls)?.keys() ?? [])].map((property) =>
				property === undefined ? `${decorator} on ${cls.name}` : `${decorator} on ${cls.name}.${String(property)}`,
			),
		),
	);

/**
 * Loads class-transformer's metadata storage. Resolves to `undefined` when class-transformer can't be loaded (it is an
 * optional peer dependency: without it, no class can carry its decorators) or its storage has an unknown shape.
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
	return (target) => decoratorsIn(storage, target);
};
