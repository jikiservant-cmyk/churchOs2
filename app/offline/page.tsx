import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Offline — churchOs',
  robots: { index: false, follow: false },
};

// Served from the service worker cache when a navigation fails offline.
// Server-rendered and dependency-free so it is cheap to precache and renders
// without any JavaScript.
export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-6 bg-[#F0E6D3] px-6 text-center text-[#1E1208]">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#1E1208] text-2xl font-bold text-[#F0E6D3]">
        ch
      </div>
      <h1 className="text-2xl font-semibold">You are offline</h1>
      <p className="max-w-sm text-sm leading-relaxed opacity-80">
        churchOs needs a connection to load attendance, member records and
        giving data. Reconnect and this page will refresh.
      </p>
      <Link
        href="/"
        className="rounded-full bg-[#1E1208] px-6 py-3 text-sm font-medium text-[#F0E6D3]"
      >
        Try again
      </Link>
    </main>
  );
}
