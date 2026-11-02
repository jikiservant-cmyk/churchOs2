import { getChurchBySlug } from '@/lib/db';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import AdminSidebar from '@/components/AdminSidebar';
import { describeAccessFailure, verifyChurchAdminAccess } from '@/lib/supabase/church-access';
import { activationPathFor, resolveActivationGate } from '@/lib/activation-gate';
import { CHURCH_ADMIN_ROLES, hasAllowedRole } from '@/lib/auth-security';

/** A church that should be paying but reached the portal is worth a log line. */
function describeActivationBypass(surface: string, slug: string, reason: string) {
  console.warn(`[${surface}] church="${slug}" activation gate=${reason}; routing to the activation screen.`);
}

/** Roles this layout recognises while routing; privilege is checked below it. */
const LAYOUT_IDENTIFIABLE_ROLES = ['pastor', 'admin', 'staff', 'member', 'overseer'] as const;

export default async function AdminLayout({ 
  children, 
  params 
}: { 
  children: React.ReactNode, 
  params: Promise<{ church_slug: string }> 
}) {
  const { church_slug } = await params;
  let church = await getChurchBySlug(church_slug);

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  // Role Check using admin client to reliably bypass RLS restrictions.
  //
  // The profile read goes through verifyChurchAdminAccess because an empty
  // service-role result is ambiguous: it means either "this account has no
  // profile" or "public.admin_profiles has RLS enabled with no policy for
  // service_role", which Postgres reports as zero rows and NO error. Reading the
  // same row through the caller's own policy (`USING (id = auth.uid())`)
  // separates them. Without that, the second case redirects a working pastor to
  // /signup/provision, where the honest-looking next click creates a duplicate
  // church.
  const adminSupabase = await createAdminClient();
  const verified = await verifyChurchAdminAccess({
    adminClient: adminSupabase,
    userClient: supabase,
    userId: user.id,
    // This pass establishes identity and tenant only; the role routing (overseer
    // vs pastor/admin) is this layout's own business further down.
    allowedRoles: LAYOUT_IDENTIFIABLE_ROLES,
  });
  const profile = verified.profile;

  if (verified.outcome.kind !== 'granted') {
    const genuineMemberGap = verified.outcome.kind === 'denied' && verified.outcome.reason === 'no-profile';
    if (genuineMemberGap) {
      redirect('/signup/provision');
    }
    describeAccessFailure('AdminLayout', user.id, null, verified);
    return (
      <div className="min-h-screen bg-[#E4D5BC] flex items-center justify-center p-12 text-center">
        <div className="bg-[#F0E6D3] p-8 rounded-3xl border border-[#B5622A]/20 shadow-xl max-w-md">
          <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-4">
            Workspace check unavailable
          </h2>
          <p className="text-[#9A7E65] text-sm leading-relaxed">
            {'error' in verified.outcome ? verified.outcome.error : 'The server could not verify your workspace membership.'}
          </p>
          <Link href="/" className="inline-block mt-6 px-6 py-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl font-bold uppercase tracking-widest text-xs">Return Home</Link>
        </div>
      </div>
    );
  }

  // An authenticated grant without a tenant is still the "not provisioned yet" case.
  if (!profile?.tenant_id) {
    redirect('/signup/provision');
  }

  // A denomination-admin link is an additional portal membership. Keep a
  // pastor/admin in this church portal while exposing a switch link below.
  const { data: overseerLink } = await adminSupabase
    .schema('church')
    .from('denomination_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const hasOverseerAccess = overseerLink?.user_id === user.id;

  // Preserve routing for legacy profiles that still carry the old role value.
  if (profile.role === 'overseer') {
    redirect('/overseer');
  }

  // Only church administrators and pastors may enter the church admin portal.
  if (!hasAllowedRole(profile.role, CHURCH_ADMIN_ROLES)) {
    redirect(`/?error=Access Denied`);
  }

  // If church was not found by the slug in the URL, recover using the pastor's tenant_id
  if (!church) {
    const { data: pastorChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('*')
      .eq('id', profile.tenant_id)
      .maybeSingle();

    if (pastorChurch?.slug) {
      redirect(`/${pastorChurch.slug}/admin`);
    } else {
      redirect('/signup/provision');
    }
  }

  // Church Mismatch Check
  if (church.id !== profile.tenant_id) {
    const { data: correctChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', profile.tenant_id)
      .maybeSingle();
      
    if (correctChurch?.slug && correctChurch.slug !== church_slug) {
      redirect(`/${correctChurch.slug}/admin`);
    } else {
       // If mismatch but no clear home, just render error instead of redirect loop
       return (
         <div className="min-h-screen bg-[#E4D5BC] flex items-center justify-center p-12 text-center">
            <div className="bg-[#F0E6D3] p-8 rounded-3xl border border-[#B5622A]/20 shadow-xl max-w-md">
               <h2 className="text-2xl font-bold text-[#1E1208] mb-4">Church Mismatch</h2>
               <p className="text-[#9A7E65]">You are not authorized to manage this church portal. Please contact support if this is an error.</p>
               <Link href="/" className="inline-block mt-6 px-6 py-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl font-bold uppercase tracking-widest text-xs">Return Home</Link>
            </div>
         </div>
       );
    }
  }

  // App Gate: activation status, decided by lib/activation-gate so this layout,
  // the root login page, the activation page and the payment initiator cannot
  // disagree. Anything that is not settled — including a status column this
  // repository never declared — routes to the payment screen instead of leaking
  // the dashboard; 'suspended' keeps its own notice below.
  const activationGate = resolveActivationGate(church);
  if (activationGate.decision === 'pay') {
    describeActivationBypass('AdminLayout', church_slug, activationGate.reason);
    redirect(activationPathFor(church_slug));
  } else if (activationGate.decision === 'suspended') {
    return (
      <div 
        style={{ fontFamily: "'Outfit', sans-serif" }}
        className="min-h-screen bg-[#2B1A0E] flex items-center justify-center p-6 text-center"
      >
        <div className="bg-[#F0E6D3] p-8 rounded-3xl border border-[#B5622A]/20 shadow-2xl max-w-md w-full">
          <div className="w-12 h-12 bg-[#B5622A]/10 text-[#B5622A] rounded-full flex items-center justify-center mx-auto mb-4 font-bold text-xl">
            !
          </div>
          <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-3">
            Workspace Suspended
          </h2>
          <p className="text-[#9A7E65] text-sm leading-relaxed mb-6">
            This church workspace ({church.name}) has been temporarily suspended. Please contact administrative support to reactivate your portal.
          </p>
          <form action="/api/auth/logout" method="POST">
            <button 
              type="submit" 
              className="w-full py-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl font-bold uppercase tracking-widest text-xs hover:bg-[#3D2614] transition-all"
            >
              Sign Out
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="h-screen bg-[#E4D5BC] flex overflow-hidden"
    >
      <AdminSidebar church={church} churchSlug={church_slug} hasOverseerAccess={hasOverseerAccess} />
      <main className="flex-1 h-full overflow-y-auto px-6 py-8 md:px-12 md:py-10">
        <div className="max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
