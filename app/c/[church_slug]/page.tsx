export const dynamic = "force-dynamic";

import { getChurchBySlug } from '@/lib/db';
import GivingPortal from '@/components/GivingPortal';
import { PUBLIC_GIVING_ENABLED } from '@/lib/public-giving';

export default async function GivingPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await params;
  
  if (['404', '500', '_error', '_not-found', 'favicon.ico', 'api'].includes(resolvedParams.church_slug)) {
    return null;
  }

  const church = await getChurchBySlug(resolvedParams.church_slug);

  if (!church) {
    return null;
  }

  if (!PUBLIC_GIVING_ENABLED) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F8F9FA] px-6 py-12 font-sans">
        <section role="status" className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-lg ring-1 ring-black/5">
          <h1 className="text-2xl font-bold text-gray-900">{church.name}</h1>
          <h2 className="mt-6 text-lg font-semibold text-gray-800">Online giving is coming soon</h2>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            Online giving is not available yet. Please contact the church directly if you would like to give.
          </p>
        </section>
      </main>
    );
  }

  return <GivingPortal church={church} />;
}
