import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getOverseerDashboardData } from '@/lib/overseer-actions';
import { getMyLoginContext } from '@/lib/denomination';
import OverseerDashboardClient from '@/components/overseer/OverseerDashboardClient';
import { LogOut, ExternalLink, RefreshCw, Shield } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Standalone overseer route. Dual-role users (pastor + overseer) never see
 * this page: they are sent straight into their own church shell at
 * /c/<slug>/admin/overseer, where oversight is one section of their normal
 * app. What remains here is for overseers without a church workspace of
 * their own — same data, same humble styling, no separate console identity.
 */
export default async function OverseerPage() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/admin/login?error=Please%20sign%20in%20to%20access%20the%20Overseer%20Portal');
  }

  // Check login context
  const context = await getMyLoginContext();

  // The denomination_admins membership relation is authoritative for overseer
  // access. A linked pastor may hold both memberships, so don't redirect based
  // on a pastor-first login context before checking that relation.

  // A user who also pastors a church gets oversight inside that church's own
  // shell — the admin layout authorises them there independently.
  const adminSupabase = await createAdminClient();
  const { data: profile } = await adminSupabase
    .from('admin_profiles')
    .select('tenant_id')
    .eq('id', user.id)
    .maybeSingle();
  if (profile?.tenant_id) {
    const { data: church } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', profile.tenant_id)
      .maybeSingle();
    if (church?.slug) {
      redirect(`/${church.slug}/admin/overseer`);
    }
  }

  // Fetch overseer data
  const data = await getOverseerDashboardData();

  if ('error' in data && data.error) {
    if (data.error.includes('Authentication required')) {
      redirect('/admin/login?error=Session%20Expired');
    }
    if (data.error.includes('overseer access required')) {
      if (context?.account_type === 'pastor' && context.church_slug) {
        redirect(`/${context.church_slug}/admin`);
      }
      redirect('/');
    }
  }

  if ('error' in data) {
    return (
      <main className="min-h-screen bg-[#E4D5BC] px-6 py-16 text-[#1E1208]">
        <section role="alert" className="mx-auto max-w-xl rounded-2xl border border-[#B5622A]/25 bg-[#F0E6D3] p-8 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <Shield className="h-6 w-6 text-[#B5622A]" />
            <h1 className="text-xl font-bold">Overseer dashboard unavailable</h1>
          </div>
          <p className="text-sm text-[#6B513E]">{data.error}</p>
          <Link href="/overseer" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#2B1A0E] px-4 py-2.5 text-sm font-semibold text-white">
            <RefreshCw className="h-4 w-4" /> Retry
          </Link>
        </section>
      </main>
    );
  }

  const { churches, invites, totals } = data;
  const denominationName = context?.denomination_name || totals.denomination_name || 'Denomination';
  const denominationSlug = context?.denomination_slug || totals.denomination_slug;

  return (
    <div
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="min-h-screen bg-[#E4D5BC] text-[#1E1208]"
    >
      {/* Top bar — same language as the app's other chrome, no separate identity */}
      <header className="border-b border-[rgba(90,55,20,0.1)] bg-[#F0E6D3]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              style={{ fontFamily: "'Playfair Display', serif" }}
              className="text-lg font-bold tracking-tight text-[#1E1208]"
            >
              {denominationName}
            </span>
            <span className="px-2 py-0.5 bg-[#B5622A]/10 text-[#B5622A] text-[10px] font-bold uppercase tracking-wider rounded-md border border-[#B5622A]/20">
              Overseer
            </span>
          </div>

          <div className="flex items-center gap-3">
            {denominationSlug && (
              <Link
                href={`/d/${denominationSlug}`}
                target="_blank"
                className="hidden sm:flex items-center gap-1.5 text-xs font-bold text-[#6B513E] hover:text-[#B5622A] px-3 py-2 rounded-xl hover:bg-white/50 transition-colors"
              >
                <span>Public page</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            )}

            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="px-3.5 py-2 bg-white/70 hover:bg-white border border-[rgba(90,55,20,0.12)] text-[#1E1208] rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 shadow-2xs"
              >
                <LogOut className="w-3.5 h-3.5 text-[#B5622A]" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <OverseerDashboardClient
          initialTotals={totals}
          initialChurches={churches}
          initialInvites={invites}
          userEmail={user.email || ''}
          denominationName={denominationName}
          denominationSlug={denominationSlug || undefined}
        />
      </main>
    </div>
  );
}
