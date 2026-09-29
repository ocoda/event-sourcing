/**
 * How a store manages its schema.
 */
export interface SchemaOptions {
	/**
	 * - `'auto'`: `ensureCollection` creates missing tables, indexes and catalog entries.
	 * - `'none'`: the store only checks the schema; a DBA creates it, for instance with the statements of a dry-run
	 *   `migrate()`.
	 * @default 'auto'
	 */
	ddl?: 'auto' | 'none';
}
