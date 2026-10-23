import type {NextConfig} from 'next';

// Origins allowed to call Server Actions and to access the dev server.
// Covers local dev, Google Cloud Run / Studio previews, and Arena (e2b) previews.
const allowedOrigins = [
  'localhost:3000',
  '127.0.0.1:3000',
  '*.run.app',
  '*.google.com',
  '*.googleusercontent.com',
  '*.e2b.app',
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
