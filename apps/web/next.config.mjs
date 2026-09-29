/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  output: 'export',
  // Relative assets keep the packaged renderer self-contained. Development
  // serves from the Next.js server root, where a relative prefix breaks
  // Turbopack chunk loading and leaves the page unhydrated.
  ...(process.env.NODE_ENV === 'production' ? { assetPrefix: '.' } : {}),
  trailingSlash: true,
};

export default nextConfig;
