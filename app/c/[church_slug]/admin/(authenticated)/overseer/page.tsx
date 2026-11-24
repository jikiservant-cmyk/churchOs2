import { redirect } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { requireTenant } from '@/lib/tenant';
import { getOverseerDashboardData } from '@/lib/overseer-actions';
import { getMyLoginContext } from '@/lib/denomination';
import OverseerDashboardClient from '@/components/overseer/OverseerDashboardClient';

export const dynamic = 'force-dynamic';

/**
 * The overseer view INSIDE the church admin shell — the page behind the
 * sidebar's "Overseer" item for dual-role (pastor + overseer) users.
 *
 * It is deliberately boring: same layout, same heading style, same cards as
 * Members or Settings. The church remains the home screen; oversight is one
 * more section of their own app, not a separate console. All data comes from
 * the same denomination-scoped aggregate RPCs the standalone page uses —
 * counts only, never sister-church member lists.
 */
export default async function OverseerAdminPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await params;
  const { church, user, supabase } = await requireTenant(resolvedParams.church_slug);

  // The admin layout has already verified church membership; this page only
  // adds the overseer-membership check. A pastor without the denomination
  // link simply goes back to their dashboard — the item should not have
  // rendered for them anyway.
  const { data: overseerLink } = await supabase
    .schema('church')
    .from('denomination_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (overseerLink?.user_id !== user.id) {
    redirect(`/${resolvedParams.church_slug}/admin`);
  }

  const [data, context] = await Promise.all([
    getOverseerDashboardData(),
    getMyLoginContext(supabase),
  ]);

  if ('error' in data) {
    if (data.error.includes('Authentication required')) {
      redirect('/?error=Session%20Expired');
    }
    // Anything else (stale link, RPC hiccup): the church dashboard is still
    // a safe home rather than a dead end.
    redirect(`/${resolvedParams.church_slug}/admin`);
  }

  const denominationName = context?.denomination_name || data.totals.denomination_name || 'your denomination';
  const denominationSlug = context?.denomination_slug || data.totals.denomination_slug;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header — matches Members / Settings heading style */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208]">
            Overseer
          </h1>
          <p className="text-[13px] text-[#9A7E65] mt-1.5 font-medium">
            Your denomination network — {denominationName}. Sister churches appear as counts only; their member
            records stay private to each pastor.
          </p>
        </div>
        {denominationSlug && (
          <Link
            href={`/d/${denominationSlug}`}
            target="_blank"
            className="inline-flex items-center gap-1.5 rounded-xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] px-4 py-2.5 text-xs font-bold text-[#6B513E] hover:text-[#B5622A] transition-colors"
          >
            <span>Public page</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>

      <OverseerDashboardClient
        initialTotals={data.totals}
        initialChurches={data.churches}
        initialInvites={data.invites}
        userEmail={user.email || ''}
        denominationName={denominationName}
        denominationSlug={denominationSlug || undefined}
      />
    </div>
  );
}
