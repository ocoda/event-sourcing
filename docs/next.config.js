const { base } = require('@faker-js/faker');

const withNextra = require('nextra')({
    theme: 'nextra-theme-docs',
    themeConfig: './theme.config.tsx',
});
   
module.exports = { 
    ...withNextra(),
    distDir: 'dist',
    basePath: "/nextjs-github-pages",
    images: { unoptimized: true }, 
    output: 'export',
    eslint: {
        ignoreDuringBuilds: true,
    }
}
   