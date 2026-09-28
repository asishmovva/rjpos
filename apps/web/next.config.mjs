/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  output: 'export',
  // Electron loads the exported register from file:// in production. Relative
  // assets keep the bundled renderer self-contained instead of resolving
  // /_next against the filesystem root.
  assetPrefix: '.',
  trailingSlash: true,
};

export default nextConfig;
