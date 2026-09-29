import type {Metadata} from 'next';
import { Outfit, Playfair_Display } from 'next/font/google';
import './globals.css';
import GlobalClientWrapper from "@/components/GlobalClientWrapper";

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-sans',
});

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'churchOs - Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
  description: 'Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
  openGraph: {
    title: 'churchOs - Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
    description: 'Multi-tenant SaaS for churches with MoMo giving and admin dashboard.',
  },
};

export const viewport = {
  themeColor: '#1E1208',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${outfit.variable} ${playfair.variable}`}>
      <body suppressHydrationWarning>
        <GlobalClientWrapper>
          {children}
        </GlobalClientWrapper>
      </body>
    </html>
  );
}
