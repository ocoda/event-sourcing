/**
 * What a conformance suite factory hands to the suite.
 */
export interface ConformanceStoreHandle<TStore> {
	/**
	 * The connected store under test.
	 */
	store: TStore;
	/**
	 * Called once after the last test: drop the given collections (tables) and disconnect the store.
	 * The list also names collections the suite expected to never be created, so ignore those that don't exist.
	 */
	cleanup: (collections: string[]) => void | Promise<void>;
}
