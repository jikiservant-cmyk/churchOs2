import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getOverseerDashboardData } from '@/lib/overseer-actions';
import { getMyLoginContext } from '@/lib/denomination';
import { requireOverseer } from '@/lib/overseer-gate';
import OverseerDashboardClient from '@/components/overseer/OverseerDashboardClient';
import { Building2, Shield, LogOut, ExternalLink, RefreshCw } from 'lucide-react';
import Link from 'next/link';

export default async function OverseerPage() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/admin/login?error=Please%20sign%20in%20to%20access%20the%20Overseer%20Portal');
  }

  // FAIL CLOSED: only accounts the database identifies as overseer may use
  // this portal. Previously, when the context RPC was unavailable the page
  // rendered for ANY signed-in user (pastors, staff, …) and fired the
  // overseer_* data queries with their session.
  const gate = await requireOverseer();
  if (!gate.allowed) {
    if (gate.reason === 'not_overseer') {
      redirect('/?error=Access%20Denied');
    }
    redirect('/admin/login?error=Please%20sign%20in%20to%20access%20the%20Overseer%20Portal');
  }

  // Check login context
  const context = await getMyLoginContext();

  // If user has a pastor context rather than overseer, redirect them to their church
  if (context && context.account_type === 'pastor' && context.church_slug) {
    redirect(`/${context.church_slug}/admin`);
  }

  // Fetch overseer data
  const data = await getOverseerDashboardData();

  if ('error' in data && data.error && data.error.includes('Authentication required')) {
    redirect('/admin/login?error=Session%20Expired');
  }

  const churches = ('churches' in data && data.churches) ? data.churches : [];
  const invites = ('invites' in data && data.invites) ? data.invites : [];

  const totals = ('totals' in data && data.totals) ? data.totals : {
    total_churches: churches.length,
    total_members: 0,
    total_giving: 0,
    active_pastors: 0,
    denomination_name: context?.denomination_name || 'Diocese Network',
  };

  const denominationName = context?.denomination_name || totals.denomination_name || 'Denomination Oversight';
  const denominationSlug = context?.denomination_slug || totals.denomination_slug;

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }} 
      className="min-h-screen bg-[#E4D5BC] text-[#1E1208]"
    >
      {/* Top Navigation Bar */}
      <header className="border-b border-[rgba(90,55,20,0.1)] bg-[#F0E6D3]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#2B1A0E] text-[#F5E6CE] flex items-center justify-center font-bold text-lg shadow-sm">
              <Building2 className="w-5 h-5 text-[#B5622A]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span 
                  style={{ fontFamily: "'Playfair Display', serif" }} 
                  className="text-xl font-bold tracking-tight block text-[#1E1208]"
                >
                  {denominationName}
                </span>
                <span className="px-2 py-0.5 bg-[#B5622A]/10 text-[#B5622A] text-[10px] font-bold uppercase tracking-wider rounded-md border border-[#B5622A]/20">
                  Overseer
                </span>
              </div>
              <span className="text-[10px] text-[#9A7E65] font-bold uppercase tracking-widest block">
                Regional Ecclesiastical Governance
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {denominationSlug && (
              <Link
                href={`/d/${denominationSlug}`}
                target="_blank"
                className="hidden sm:flex items-center gap-1.5 text-xs font-bold text-[#6B513E] hover:text-[#B5622A] px-3 py-2 rounded-xl hover:bg-white/50 transition-colors"
              >
                <span>Public Network</span>
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

      {/* Main Content Area */}
      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 
            style={{ fontFamily: "'Playfair Display', serif" }}
            className="text-3xl font-bold text-[#1E1208]"
          >
            Diocesan Oversight Console
          </h1>
          <p className="text-sm text-[#9A7E65] mt-1">
            Regional congregation metrics, pastor invite codes, and denomination network membership.
          </p>
        </div>

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
