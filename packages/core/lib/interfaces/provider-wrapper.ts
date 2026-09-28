import type { DiscoveryService } from '@nestjs/core';

export type ProviderWrapper<T = unknown> = ReturnType<DiscoveryService['getProviders']>[number] & {
	instance?: T;
};
