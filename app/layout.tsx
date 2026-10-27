import type {Metadata} from 'next';
// Self-hosted brand fonts (Fontsource). Previously these came from
// next/font/google, which fetches from fonts.googleapis.com at build time
// and hard-fails the build in network-restricted environments (CI, Cloud
// Build, sandboxes). Bundling them keeps builds hermetic and works offline.
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/outfit/800.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/500.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/800.css';
import './globals.css';
import GlobalClientWrapper from "@/components/GlobalClientWrapper";

export const metadata: Metadata = {
  title: 'churchOs - Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
  description: 'Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
  applicationName: 'churchOs',
  // app/manifest.ts is served at /manifest.webmanifest by Next; reference it
  // explicitly so it is linked even on routes that do not auto-emit it.
  manifest: '/manifest.webmanifest',
  // iOS ignores the web manifest almost entirely. Without this, "Add to Home
  // Screen" opens the site in a Safari tab with browser chrome instead of
  // full-screen, and the title on the home screen is the page title.
  appleWebApp: {
    capable: true,
    title: 'churchOs',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'churchOs - Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
    description: 'Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
  },
  formatDetection: { telephone: false },
  // Next emits the standard `mobile-web-app-capable` only. iOS before 17
  // requires the apple-prefixed name to honour standalone mode, and a church
  // running older iPhones is exactly the audience for this app.
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
};

export const viewport = {
  themeColor: '#1E1208',
  width: 'device-width',
  initialScale: 1,
  // Installed on iOS the app must respect the notch; without this the header
  // sits under the status bar in standalone mode.
  viewportFit: 'cover' as const,
  maximumScale: 5,
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <GlobalClientWrapper>
          {children}
        </GlobalClientWrapper>
      </body>
    </html>
  );
}
