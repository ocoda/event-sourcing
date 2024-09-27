const basePath = process.env.ASSET_PREFIX || '';

const withNextra = require('nextra')({
    theme: 'nextra-theme-docs',
    themeConfig: './theme.config.tsx',
});
   
module.exports = { 
    ...withNextra(),
    distDir: 'dist',
    basePath,
    images: { unoptimized: true }, 
    output: 'export',
    eslint: {
        ignoreDuringBuilds: true,
    }
}
   