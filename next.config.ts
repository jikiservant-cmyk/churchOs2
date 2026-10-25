import type {NextConfig} from 'next';

// Next.js normally accepts same-origin Server Actions. Only add an exact
// configured application host for reverse-proxy deployments; broad provider
// wildcards would let unrelated tenants on those providers submit authenticated
// Server Action requests (CSRF).
const configuredAppHost = (() => {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return null;
  try {
    return new URL(appUrl).host;
  } catch {
    return null;
  }
})();
const localDevOrigins = process.env.NODE_ENV === 'development'
  ? ['localhost:3000', '127.0.0.1:3000']
  : [];
// Arena preview host is derived from this sandbox's ID, rather than trusting
// every tenant on the shared e2b.app domain.
const arenaPreviewHost = process.env.NODE_ENV === 'development' && process.env.E2B_SANDBOX_ID
  ? `3000-${process.env.E2B_SANDBOX_ID}.e2b.app`
  : null;
const allowedOrigins = [
  ...localDevOrigins,
  ...(configuredAppHost ? [configuredAppHost] : []),
  ...(arenaPreviewHost ? [arenaPreviewHost] : []),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    serverActions: {
      allowedOrigins,
      bodySizeLimit: '1mb',
    },
  },
  // @ts-ignore Next.js 15+ allowedDevOrigins
  allowedDevOrigins: allowedOrigins,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'picsum.photos', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'images.unsplash.com', port: '', pathname: '/**' },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/:church_slug((?!overseer|denominations|d|admin|signup|api|_next|login).*)',
        destination: '/c/:church_slug',
      },
      {
        source: '/:church_slug((?!overseer|denominations|d|admin|signup|api|_next|login).*)/:path*',
        destination: '/c/:church_slug/:path*',
      }
    ]
  },
};

export default nextConfig;
