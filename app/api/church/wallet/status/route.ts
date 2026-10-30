import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient, isServiceRoleConfigured } from '@/lib/supabase/server';
import { CHURCH_ADMIN_ROLES, resolveChurchAdminAccess } from '@/lib/auth-security';
import { readWalletWithColumnFallback, walletDerivedBalanceUgx, walletSmsRate } from '@/lib/wallet-read';

export const dynamic = 'force-dynamic';

/**
 * GET /api/church/wallet/status?church_id=<uuid>&reference=<CHURCH-...>
 *
 * Returns current wallet balance + latest transaction status for polling after
 * a Najiki top-up. Mirrors the activation status polling pattern.
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceRoleConfigured = isServiceRoleConfigured();
    const adminSupabase = await createAdminClient();
    const { data: profile, error: profileError } = serviceRoleConfigured
      ? await adminSupabase
          .from('admin_profiles')
          .select('tenant_id, role')
          .eq('id', user.id)
          .maybeSingle()
      : { data: null, error: null };

    const access = resolveChurchAdminAccess({
      serviceRoleConfigured,
      profile: profile ?? null,
      profileLookupFailed: Boolean(profileError),
      allowedRoles: CHURCH_ADMIN_ROLES,
    });
    if (access.kind !== 'granted') {
      if (profileError) {
        console.error('[Wallet Status] admin_profiles lookup failed:', profileError.code ?? '', profileError.message);
      }
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (!profile?.tenant_id) {
      return NextResponse.json({ error: 'A linked pastor or administrator account is required' }, { status: 403 });
    }

    const churchIdParam = req.nextUrl.searchParams.get('church_id') || req.nextUrl.searchParams.get('churchId');
    if (churchIdParam && churchIdParam !== profile.tenant_id) {
      return NextResponse.json({ error: 'Access denied for this church workspace' }, { status: 403 });
    }
    const targetTenantId = profile.tenant_id;
    const referenceParam = req.nextUrl.searchParams.get('reference')?.trim() || null;

    // Fetch wallet (service role to bypass RLS, ensure we see balance even if RLS
    // filtered). `sms_rate` is optional: deployments whose wallets table predates
    // that column used to answer 42703 here, which surfaced as a zero balance on a
    // funded wallet. See lib/wallet-read.ts.
    let wallet: any = null;
    let walletReadFailed = false;
    const readers = [
      { label: 'service-role', ready: serviceRoleConfigured, client: adminSupabase },
      // The caller's own tenant, verified above; the RLS policy scopes the read to
      // `tenant_id = church.my_tenant_id()`, so the fallback cannot widen access.
      { label: 'RLS', ready: true, client: supabase },
    ];
    for (const reader of readers) {
      if (!reader.ready) continue;
      const result = await readWalletWithColumnFallback((columns) =>
        reader.client.from('wallets').select(columns).eq('tenant_id', targetTenantId).maybeSingle(),
      );
      if (result.wallet) {
        wallet = result.wallet;
        if (result.degraded) {
          console.warn(`[Wallet Status] public.wallets has no sms_rate column (${reader.label}); using the default rate`);
        }
        break;
      }
      if (result.error) {
        walletReadFailed = true;
        console.error(`[Wallet Status] Wallet lookup via ${reader.label} failed:`, result.error.code ?? '', result.error.message ?? '');
      } else {
        console.warn(`[Wallet Status] No public.wallets row for tenant ${targetTenantId} via ${reader.label}`);
      }
    }

    if (!wallet && walletReadFailed) {
      return NextResponse.json({ error: 'Unable to fetch wallet balance' }, { status: 500 });
    }

    const balanceUgx = walletDerivedBalanceUgx(wallet);
    const smsRate = walletSmsRate(wallet);
    const remainingSMS = Math.floor(balanceUgx / smsRate);

    // Fetch latest transaction(s)
    let transaction: any = null;
    if (referenceParam) {
      // Try exact reference_code or reference (Najiki's reference)
      const { data: byRef } = await adminSupabase
        .from('wallet_transactions')
        .select('id, reference_code, reference, payment_intent_id, amount, currency, status, note, created_at, updated_at')
        .eq('tenant_id', targetTenantId)
        .or(`reference_code.eq.${referenceParam},reference.eq.${referenceParam}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (byRef) {
        transaction = byRef;
      } else {
        // Fallback: try idempotency prefix search (reference without prefix)
        const { data: byRecent } = await adminSupabase
          .from('wallet_transactions')
          .select('id, reference_code, reference, payment_intent_id, amount, currency, status, note, created_at, updated_at')
          .eq('tenant_id', targetTenantId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        transaction = byRecent;
      }
    } else {
      const { data: latest } = await adminSupabase
        .from('wallet_transactions')
        .select('id, reference_code, reference, payment_intent_id, amount, currency, status, note, created_at, updated_at')
        .eq('tenant_id', targetTenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      transaction = latest;
    }

    return NextResponse.json({
      churchId: targetTenantId,
      balance: balanceUgx,
      balanceUgx,
      smsRate,
      remainingSMS,
      leftoverUGX: balanceUgx % smsRate,
      transaction: transaction
        ? {
            id: transaction.id,
            reference: transaction.reference_code,
            najikiReference: transaction.reference,
            paymentIntentId: transaction.payment_intent_id,
            amount: transaction.amount,
            currency: transaction.currency,
            status: transaction.status,
            note: transaction.note,
            createdAt: transaction.created_at,
            updatedAt: transaction.updated_at,
          }
        : null,
      wallet: wallet ? { balance: wallet.balance, sms_rate: wallet.sms_rate } : null,
    });
  } catch (err: any) {
    console.error('[Wallet Status] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}
