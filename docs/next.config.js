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
   