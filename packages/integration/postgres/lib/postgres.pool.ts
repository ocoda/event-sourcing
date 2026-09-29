import { Pool, type PoolConfig } from 'pg';

/**
 * The options of a store config that belong to the store rather than to the `pg` pool.
 */
type StoreOnlyOptions = { driver?: unknown; useDefaultPool?: unknown; ddl?: unknown };

/**
 * The `pg` pool config of a store config: the config without the store's own options (`driver`, `useDefaultPool`,
 * `ddl`), which aren't the pool's.
 */
export const poolConfigOf = (config: PoolConfig & StoreOnlyOptions): PoolConfig => {
	const { driver: _driver, useDefaultPool: _useDefaultPool, ddl: _ddl, ...poolConfig } = config;
	return poolConfig;
};

/**
 * Creates a pool. Idle connections that fail are discarded by the pool and reported to `onIdleError`: without a
 * listener, the error would crash the process.
 */
export const createPool = (config: PoolConfig, onIdleError: (error: Error) => void): Pool => {
	const pool = new Pool(config);
	pool.on('error', onIdleError);
	return pool;
};
