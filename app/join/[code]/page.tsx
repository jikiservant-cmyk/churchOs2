import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { hashChurchInviteCode, CHURCH_JOIN_CODE_PATTERN } from '@/lib/invite-code';
import JoinDenominationClient from '@/components/join/JoinDenominationClient';

export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        {children}
      </section>
    </main>
  );
}

function InvalidCard({ message }: { message: string }) {
  return (
    <Shell>
      <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-700">
        <ShieldCheck className="h-6 w-6" />
      </div>
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-rose-700">Church join link</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">This link cannot be used</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">{message}</p>
      <Link
        href="/"
        className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-5 py-3.5 text-sm font-semibold text-white hover:bg-slate-700"
      >
        Back to home
      </Link>
    </Shell>
  );
}

/**
 * One-click church join link — the universal entry a denomination overseer
 * shares instead of a bare code. Whatever state the visitor is in, it routes
 * to the right next step:
 *
 *   signed out            -> login (which returns here afterwards)
 *   account, no church    -> signup provisioning with the code pre-loaded
 *   pastor, independent   -> one-tap confirmation, joins via the existing
 *                            `join_denomination_with_invite` RPC
 *   pastor, already in    -> says so; no write is attempted
 *
 * All reads are service-role lookups by the code's SHA-256 hash; the only
 * write still goes through the pastor-scoped RPC, exactly like the
 * Settings -> Denomination Network card. Nothing new is writable.
 */
export default async function JoinChurchPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!CHURCH_JOIN_CODE_PATTERN.test(code)) {
    return <InvalidCard message="This church join link is malformed and cannot be honoured." />;
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) {
    redirect(`/admin/login?returnTo=${encodeURIComponent(`/join/${code}`)}`);
  }

  const admin = await createAdminClient();
  const { data: profile } = await admin
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  // No church workspace yet: send them through signup provisioning, which
  // born-links the new church to the invite's denomination in one transaction.
  if (!profile?.tenant_id) {
    redirect(`/signup/provision?invite=${encodeURIComponent(code)}`);
  }

  if (!['pastor', 'admin'].includes(String(profile.role || '').toLowerCase())) {
    return (
      <InvalidCard
        message="Only the pastor account that manages a church workspace can accept a denomination join link. Sign in with that account and open the link again."
      />
    );
  }

  const { data: invite } = await admin
    .schema('church')
    .from('denomination_invites')
    .select('id, denomination_id, expires_at, revoked_at, max_uses, used_count')
    .eq('code_hash', hashChurchInviteCode(code))
    .eq('invite_type', 'church')
    .maybeSingle();

  if (!invite) {
    return <InvalidCard message="This join link is invalid or was never issued. Ask the denomination overseer for a fresh link." />;
  }
  if (invite.revoked_at) {
    return <InvalidCard message="This join link was revoked by the denomination overseer." />;
  }
  // Server component: this render runs once per request, so reading the clock
  // here is deliberate pre-flight UX. The write path re-validates revocation,
  // expiry and use counts inside `join_denomination_with_invite` regardless.
  // eslint-disable-next-line react-hooks/purity
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return <InvalidCard message="This join link has expired. Ask the denomination overseer for a fresh one." />;
  }
  if (invite.used_count >= invite.max_uses) {
    return <InvalidCard message="This join link has already brought in its full number of churches. Ask the overseer for a new link." />;
  }

  const { data: denomination } = await admin
    .schema('church')
    .from('denominations')
    .select('name, slug, logo_url')
    .eq('id', invite.denomination_id)
    .maybeSingle();

  if (!denomination) {
    return <InvalidCard message="The denomination behind this link no longer exists." />;
  }

  const { data: church } = await admin
    .schema('church')
    .from('churches')
    .select('id, name, slug, denomination_id')
    .eq('id', profile.tenant_id)
    .maybeSingle();

  if (!church) {
    redirect(`/signup/provision?invite=${encodeURIComponent(code)}`);
  }

  if (church.denomination_id) {
    const { data: currentDenomination } = await admin
      .schema('church')
      .from('denominations')
      .select('name, slug')
      .eq('id', church.denomination_id)
      .maybeSingle();

    return (
      <Shell>
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Already connected</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">{church.name} is already linked</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {currentDenomination
            ? <>Your church belongs to <strong>{currentDenomination.name}</strong>. No action is needed here.</>
            : 'Your church already belongs to a denomination. No action is needed here.'}
        </p>
        <Link
          href={`/${church.slug}/admin/settings`}
          className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-5 py-3.5 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Open church settings
        </Link>
      </Shell>
    );
  }

  return (
    <JoinDenominationClient
      code={code}
      denominationName={denomination.name}
      denominationSlug={denomination.slug}
      logoUrl={denomination.logo_url}
      churchName={church.name}
      churchSlug={church.slug}
    />
  );
}
