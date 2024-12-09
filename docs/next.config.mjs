import nextra from 'nextra';

const forGithubPages = process.env.GITHUB_PAGES === 'true';
console.log(`Building for Github Pages: ${forGithubPages}`);

let assetPrefix = '';
let basePath = '';

if (forGithubPages) {
	const repo = 'event-sourcing';
	assetPrefix = `/${repo}/`;
	basePath = `/${repo}`;
	console.log(`Setting the asset prefix to: ${assetPrefix}`);
	console.log(`Setting the base path to: ${basePath}`);
}

const withNextra = nextra({
	theme: 'nextra-theme-docs',
	themeConfig: './theme.config.tsx',
});

export default withNextra({
	distDir: 'dist',
	basePath,
	assetPrefix,
	images: { unoptimized: true },
	output: 'export',
	eslint: {
		ignoreDuringBuilds: true,
	},
});
