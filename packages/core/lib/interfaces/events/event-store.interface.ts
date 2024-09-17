export interface EventStoreDriver<TOptions = any> {
	start(options: TOptions): unknown | Promise<unknown>;
	stop(): void | Promise<void>;
}
