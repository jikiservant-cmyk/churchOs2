import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import OverseerInviteRedeem from '@/components/super-admin/OverseerInviteRedeem';

export const dynamic = 'force-dynamic';

export default async function RedeemOverseerInvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4"><p className="rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700">This invitation link is invalid.</p></main>;
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const returnTo = `/overseer/invite/${code}`;
    redirect(`/admin/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return <OverseerInviteRedeem code={code} />;
}
