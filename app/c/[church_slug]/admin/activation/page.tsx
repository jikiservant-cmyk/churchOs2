import { getChurchBySlug } from '@/lib/db';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import ActivationClient from '@/components/activation/ActivationClient';
import { describeAccessFailure, verifyChurchAdminAccess } from '@/lib/supabase/church-access';
import { CHURCH_ADMIN_ROLES, hasAllowedRole } from '@/lib/auth-security';
import { churchAdminPathFor, resolveActivationGate } from '@/lib/activation-gate';
import { ACTIVATION_FEE_IS_TEST_PRICING, ACTIVATION_FEE_UGX, ACTIVATION_PRICE_UGX } from '@/lib/activation';

export const dynamic = 'force-dynamic';

/** Roles this screen recognises while routing; who may pay is checked below it. */
const IDENTIFIABLE_ROLES = ['pastor', 'admin', 'staff', 'member', 'overseer'] as const;

function NoticeCard({
  title,
  body,
  tone = 'warn',
}: {
  title: string;
  body: string;
  tone?: 'warn' | 'info';
}) {
  return (
    <div className="min-h-screen bg-[#E4D5BC] flex items-center justify-center p-12 text-center">
      <div className="bg-[#F0E6D3] p-8 rounded-3xl border border-[#B5622A]/20 shadow-xl max-w-md">
        <h2
          style={{ fontFamily: "'Playfair Display', serif" }}
          className="text-2xl font-bold text-[#1E1208] mb-4"
        >
          {title}
        </h2>
        {body.split('\n\n').map((paragraph) => (
          <p
            key={paragraph}
            className={`text-sm leading-relaxed mb-4 ${tone === 'warn' ? 'text-[#9A7E65]' : 'text-[#6B513E]'}`}
          >
            {paragraph}
          </p>
        ))}
        {/* POST, not a link: /api/auth/logout answers GET with 405 by design. */}
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

export default async function ChurchActivationPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  let church = await getChurchBySlug(church_slug);

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    // The only screen that may follow a missing session is the login form — the
    // root page routes an authenticated pastor straight back here, so a signed-in
    // pastor is never parked on the login screen by a stale session.
    redirect(`/?error=Session Expired`);
  }

  // This read is the difference between "you are not this church's pastor" and
  // "the server could not read admin_profiles". An empty service-role result is
  // ambiguous (RLS with no policy returns zero rows and NO error), so it goes
  // through the same verifier the admin layout uses. Bouncing this page's
  // visitors to /signup/provision used to offer a duplicate-church create button
  // to a pastor whose only problem was a missing policy.
  const adminSupabase = await createAdminClient();
  const verified = await verifyChurchAdminAccess({
    adminClient: adminSupabase,
    userClient: supabase,
    userId: user.id,
    allowedRoles: IDENTIFIABLE_ROLES,
  });
  const profile = verified.profile;

  if (verified.outcome.kind !== 'granted') {
    const genuineProvisioningGap = verified.outcome.kind === 'denied' && verified.outcome.reason === 'no-profile';
    if (genuineProvisioningGap) {
      redirect('/signup/provision');
    }
    describeAccessFailure('ActivationPage', user.id, profile?.tenant_id ?? null, verified);
    return (
      <NoticeCard
        title="Workspace check unavailable"
        body={'This server could not verify your workspace membership, so it will not ask you for payment. This is a configuration problem, not a problem with your church.\n\nSet SUPABASE_SERVICE_ROLE_KEY for this deployment, and re-apply migrations/016_rls_policy_repair.sql if public.admin_profiles has RLS enabled without a policy.'}
      />
    );
  }

  // Granted identity without a tenant is still "not provisioned yet" — the same
  // reading the admin layout applies, so the two screens never disagree.
  if (!profile?.tenant_id) {
    redirect('/signup/provision');
  }

  // Resolve the church from the account, not from the URL, whenever the two
  // disagree: the same recovery the admin layout performs. Without this, a slug
  // belonging to another tenant would render that church's name and gate while
  // charging this account's workspace — and the two screens could bounce a
  // visitor between each other.
  if ((!church || church.id !== profile.tenant_id) && profile.tenant_id) {
    const { data: tenantChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('id, name, slug, activation_status, activation_paid_at')
      .eq('id', profile.tenant_id)
      .maybeSingle();

    if (tenantChurch) {
      church = {
        id: tenantChurch.id,
        name: tenantChurch.name || tenantChurch.slug,
        slug: tenantChurch.slug,
        themeColor: 'bg-blue-600',
        logoUrl: `https://picsum.photos/seed/${tenantChurch.slug}/200/200`,
        activation_status: tenantChurch.activation_status ?? null,
        activation_paid_at: tenantChurch.activation_paid_at ?? null,
      };
    }
  }

  // No readable church row means no one can say what is owed. Asking for money
  // that the settlement path cannot then bind to a workspace is the one outcome
  // worse than a delay, so this stops here instead of rendering a pay button.
  if (!church) {
    return (
      <NoticeCard
        title="We cannot find this workspace"
        body={'Your account is valid, but this server could not read the church row it belongs to, so there is no amount to quote you. This is a data or configuration problem on the server, not something you or your church did.\n\nNo payment has been taken. Sign in with the account that owns this workspace, or contact support.'}
      />
    );
  }

  const gate = resolveActivationGate(church);

  // Already settled, or grandfathered: the dashboard owns this user, and the
  // layout will send them back here if it disagrees. Returning by hand to
  // /admin/activation must not strand them on a payment screen.
  if (gate.decision !== 'pay') {
    redirect(churchAdminPathFor(church.slug || church_slug));
  }

  // Everyone routed here sees the same page; only the account that can bind money
  // to the workspace may submit it. The start endpoint enforces this again — the
  // notice exists so a staff account is never shown a button that only fails.
  if (!hasAllowedRole(profile.role, CHURCH_ADMIN_ROLES)) {
    return (
      <NoticeCard
        tone="info"
        title="Activation is held by the church administrator"
        body={`${church.name || 'This workspace'} is not active yet. A pastor or administrator on this account must approve the activation payment; you have access as “${profile.role || 'team member'}”, so this screen is read-only for you.`}
      />
    );
  }

  return (
    <ActivationClient
      churchName={church.name || church_slug}
      churchSlug={church.slug || church_slug}
      churchId={profile.tenant_id as string}
      userEmail={user.email || ''}
      activationFeeUgx={ACTIVATION_FEE_UGX}
      standardFeeUgx={ACTIVATION_PRICE_UGX}
      isTestPricing={ACTIVATION_FEE_IS_TEST_PRICING}
    />
  );
}
