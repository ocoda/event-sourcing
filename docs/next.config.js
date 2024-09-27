const forGithubPages = process.env.GITHUB_PAGES || false

let assetPrefix = '';
let basePath = '';

if (forGithubPages) {
  const repo = 'event-sourcing';
  assetPrefix = `/${repo}/`;
  basePath = `/${repo}`;
}
const withNextra = require('nextra')({
    theme: 'nextra-theme-docs',
    themeConfig: './theme.config.tsx',
});
   
module.exports = { 
    ...withNextra(),
    distDir: 'dist',
    basePath,
    assetPrefix,
    images: { unoptimized: true }, 
    output: 'export',
    eslint: {
        ignoreDuringBuilds: true,
    }
}
   