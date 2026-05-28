import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from '@ocoda/event-sourcing-config/vitest/base';

export default mergeConfig(base, {
	resolve: {
		alias: [
			{ find: /^@ocoda\/event-sourcing-mongodb(\/.*)?$/, replacement: resolve(__dirname, 'lib$1') },
			{ find: /^@ocoda\/event-sourcing(\/.*)?$/, replacement: resolve(__dirname, '../../core/lib$1') },
		],
	},
});
