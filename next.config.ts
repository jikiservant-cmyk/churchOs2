import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    serverActions: {
      allowedOrigins: [
        'localhost:3000',
        '127.0.0.1:3000',
        '*.run.app',
        '*.google.com',
        '*.googleusercontent.com',
      ],
    },
  },
  // @ts-ignore Next.js 15+ allowedDevOrigins
  allowedDevOrigins: [
    'localhost:3000',
    '127.0.0.1:3000',
    '*.run.app',
    '*.google.com',
    '*.googleusercontent.com',
  ],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'picsum.photos', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'images.unsplash.com', port: '', pathname: '/**' },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/:church_slug',
        destination: '/c/:church_slug',
      },
      {
        source: '/:church_slug/:path*',
        destination: '/c/:church_slug/:path*',
      }
    ]
  },
  webpack: (config, {dev}) => {
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = { ignored: /.*/ };
    }
    return config;
  },
};

export default nextConfig;
