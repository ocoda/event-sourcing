import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import { LOGO_URL } from './src/consts';
import { headingCustomIds, rootRelativeLinks } from './src/plugins/markdown';

const site = 'https://ocoda.github.io';
const base = '/event-sourcing';

type SidebarLink = { label: string; slug: string };

const sidebar: (SidebarLink | { label: string; items: SidebarLink[] })[] = [
	{ label: 'Introduction', slug: 'index' },
	{
		label: 'Patterns',
		items: [
			{ label: 'Domain Driven Design', slug: 'patterns/ddd' },
			{ label: 'CQRS', slug: 'patterns/cqrs' },
			{ label: 'Event Sourcing', slug: 'patterns/event-sourcing' },
		],
	},
	{
		label: 'Getting started',
		items: [
			{ label: 'Installation', slug: 'start/install' },
			{ label: 'Module configuration', slug: 'start/module-configuration' },
			{ label: 'Aggregates', slug: 'start/aggregates' },
			{ label: 'Value Objects', slug: 'start/value-objects' },
			{ label: 'Repositories', slug: 'start/repositories' },
			{ label: 'Commands', slug: 'start/commands' },
			{ label: 'Events', slug: 'start/events' },
			{ label: 'Snapshots', slug: 'start/snapshots' },
			{ label: 'Queries', slug: 'start/queries' },
		],
	},
	{
		label: 'Advanced',
		items: [
			{ label: 'Multitenancy', slug: 'advanced/multitenancy' },
			{ label: 'Event Pub/Sub', slug: 'advanced/event-pubsub' },
			{ label: 'Event Serialization', slug: 'advanced/event-serialization' },
			{ label: 'Custom Stores', slug: 'advanced/custom-stores' },
		],
	},
	{
		label: 'Integrations',
		items: [
			{ label: 'PostgreSQL', slug: 'integrations/postgres' },
			{ label: 'MariaDB', slug: 'integrations/mariadb' },
			{ label: 'MongoDB', slug: 'integrations/mongodb' },
		],
	},
	{
		label: 'Under the hood',
		items: [
			{ label: 'Streams', slug: 'under-the-hood/streams' },
			{ label: 'Envelopes', slug: 'under-the-hood/envelopes' },
			{ label: 'Event store', slug: 'under-the-hood/event-store' },
			{ label: 'Snapshot store', slug: 'under-the-hood/snapshot-store' },
		],
	},
	{
		label: 'Upgrading',
		items: [
			{ label: 'Migrating from 3.x to 4.0', slug: 'upgrading/v4' },
			{ label: 'Versioning and support', slug: 'upgrading/versioning' },
		],
	},
	{ label: 'Further reading', slug: 'further-reading' },
	{ label: 'About Ocoda', slug: 'about-ocoda' },
];

/** The page slugs in sidebar order. */
const pages = sidebar.flatMap((entry) => ('items' in entry ? entry.items : [entry])).map(({ slug }) => slug);

export default defineConfig({
	site,
	base,
	markdown: {
		processor: satteri({ hastPlugins: [headingCustomIds, rootRelativeLinks(base)] }),
	},
	// The underscore URLs were linked from the docs before and are still around. Astro doesn't add the
	// base to a redirect's destination.
	redirects: {
		'/further_reading': `${base}/further-reading/`,
		'/advanced/event_pubsub': `${base}/advanced/event-pubsub/`,
		'/advanced/event_serialization': `${base}/advanced/event-serialization/`,
	},
	integrations: [
		starlight({
			title: 'Ocoda Event Sourcing',
			titleDelimiter: '–',
			description:
				'Ocoda Event Sourcing is a NestJS library with the building blocks for Domain-Driven Design, Event Sourcing and CQRS.',
			favicon: LOGO_URL,
			// SiteTitle shows the logo from the Ocoda CDN: Starlight's `logo` option only takes local images.
			// LanguageSelect adds the select of the docs versions (4.x here, 3.x under /v3/).
			components: {
				SiteTitle: './src/components/SiteTitle.astro',
				Footer: './src/components/Footer.astro',
				LanguageSelect: './src/components/LanguageSelect.astro',
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ocoda/event-sourcing' }],
			editLink: { baseUrl: 'https://github.com/ocoda/event-sourcing/edit/master/docs/' },
			head: [
				{
					tag: 'meta',
					attrs: { name: 'google-site-verification', content: 'IJJJM6mYKx0BG_eTPjp5Eudq2d4p3aH3hEB9jDVJh1U' },
				},
			],
			sidebar,
			plugins: [
				// Fails the build on a broken internal link or heading anchor.
				starlightLinksValidator(),
				starlightLlmsTxt({
					// Pages in the order of the sidebar, without the heading anchor links.
					promote: pages,
					customSelectors: { all: ['.sl-anchor-link'] },
				}),
			],
		}),
	],
});
