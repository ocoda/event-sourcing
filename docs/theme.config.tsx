import { useConfig, type DocsThemeConfig } from 'nextra-theme-docs';

const config: DocsThemeConfig = {
	logo: (
		<>
			<img src="https://ocodacdn.com/image/unsafe/plain/common://ocoda_logo_gradient.svg" width="40" alt="Ocoda Logo" />
			<span style={{ marginLeft: '.4em', fontWeight: 700 }}>Ocoda | Event Sourcing</span>
		</>
	),
	project: {
		link: 'https://github.com/ocoda/event-sourcing',
	},
	docsRepositoryBase: 'https://github.com/ocoda/event-sourcing/tree/master/docs',
	footer: {
		content: (
			<span>
				MIT {new Date().getFullYear()} ©{' '}
				{/* biome-ignore lint/a11y/noBlankTarget: link to ocoda.be */}
        <a href="https://www.ocoda.be/en" target="_blank">
					Ocoda
				</a>
				.
			</span>
		),
	},
	head: function useHead() {
		const config = useConfig();
		const title = `${config.title} – Ocoda Event Sourcing`;
		return (
			<>
				<title>{title}</title>
        <meta name="google-site-verification" content="IJJJM6mYKx0BG_eTPjp5Eudq2d4p3aH3hEB9jDVJh1U" />
			</>
		);
	},
};

export default config;
