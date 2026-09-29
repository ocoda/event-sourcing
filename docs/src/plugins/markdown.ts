import type { SatteriProcessorOptions } from '@astrojs/markdown-satteri';

type HastPlugin = NonNullable<SatteriProcessorOptions['hastPlugins']>[number];

const HEADING_ID = /\s*\[#([\w-]+)\]\s*$/;

/**
 * Supports the `## Heading [#custom-id]` syntax (carried over from Nextra) so a heading keeps a
 * stable anchor that doesn't change when its text does. `{#id}` is not an option in MDX, where
 * braces start an expression. Runs before Astro assigns heading ids, which keeps an existing id.
 */
export const headingCustomIds: HastPlugin = {
	name: 'heading-custom-ids',
	element: {
		filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
		visit(node, ctx) {
			const last = node.children.at(-1);
			if (last?.type !== 'text') return;

			const match = HEADING_ID.exec(last.value);
			if (!match) return;

			const text = last.value.slice(0, match.index);
			if (text) ctx.replaceNode(last, { type: 'text', value: text });
			else ctx.removeNode(last);
			ctx.setProperty(node, 'id', match[1]);
		},
	},
};

const PAGE_LINK = /^(?<path>\/[^?#]*)(?<rest>[?#].*)?$/;

/**
 * Resolves root-relative links in the content (`/start/install#advanced-setup`) against the site's
 * base path, so pages link to each other without hard-coding where the site is deployed. Links to
 * pages also get the trailing slash they're served with, which saves a redirect on GitHub Pages.
 * Runs before the links validator, which checks the resolved links.
 */
export function rootRelativeLinks(base: string): HastPlugin {
	const prefix = base.replace(/\/$/, '');

	return {
		name: 'root-relative-links',
		element: {
			filter: ['a'],
			visit(node, ctx) {
				const href = node.properties?.href;
				if (typeof href !== 'string' || href.startsWith('//')) return;

				const match = PAGE_LINK.exec(href);
				if (!match?.groups) return;

				let path = match.groups.path;
				if (!path.endsWith('/') && !path.split('/').at(-1)?.includes('.')) path += '/';
				if (!path.startsWith(`${prefix}/`)) path = `${prefix}${path}`;

				ctx.setProperty(node, 'href', `${path}${match.groups.rest ?? ''}`);
			},
		},
	};
}
