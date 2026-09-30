/** The Ocoda logo, served from the Ocoda CDN. */
export const LOGO_URL = 'https://ocodacdn.com/image/unsafe/plain/common://ocoda_logo_gradient.svg';

/**
 * The versions of the docs, for the version select in the header. The paths are relative to the site's base: the
 * CD Docs workflow publishes these docs at the root and the 3.x docs, built from the 3.x branch, under `/v3/`.
 */
export const DOCS_VERSIONS = [
	{ label: '4.x', path: '/', current: true },
	{ label: '3.x', path: '/v3/', current: false },
] as const;
