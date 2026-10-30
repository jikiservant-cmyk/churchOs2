import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient, isServiceRoleConfigured } from '@/lib/supabase/server';
import { verifyChurchAdminAccess, describeAccessFailure } from '@/lib/supabase/church-access';
import { CHURCH_ADMIN_ROLES } from '@/lib/auth-security';
import { readWalletWithColumnFallback, walletDerivedBalanceUgx, walletSmsRate } from '@/lib/wallet-read';

export const dynamic = 'force-dynamic';

const TRANSACTION_COLUMNS =
  'id, reference_code, reference, payment_intent_id, amount, currency, status, note, created_at, updated_at';

/**
 * GET /api/church/wallet/status?church_id=<uuid>&reference=<CHURCH-...>
 *
 * Returns current wallet balance + latest transaction status for polling after
 * a Najiki top-up. Mirrors the activation status polling pattern.
 *
 * Every read here tries the service-role client and then the caller's RLS-scoped
 * client, in that order. A table with RLS enabled and no policy returns zero rows
 * with NO error, so "no rows from the key" cannot be read as "no balance" or "no
 * transaction" — which is how a funded wallet and a settled top-up both looked
 * empty. The RLS read is scoped to `tenant_id = church.my_tenant_id()`, so the
 * fallback cannot widen access.
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const churchIdParam = req.nextUrl.searchParams.get('church_id') || req.nextUrl.searchParams.get('churchId');
    const adminSupabase = await createAdminClient();

    const verified = await verifyChurchAdminAccess({
      adminClient: adminSupabase,
      userClient: supabase,
      userId: user.id,
      // Cross-check the requested workspace; the tenant below is what is used.
      churchId: churchIdParam,
      allowedRoles: CHURCH_ADMIN_ROLES,
    });
    describeAccessFailure('Wallet Status', user.id, churchIdParam, verified);
    if (verified.outcome.kind !== 'granted') {
      return NextResponse.json(
        { error: 'error' in verified.outcome ? verified.outcome.error : 'Access denied.' },
        { status: verified.outcome.status },
      );
    }

    const targetTenantId = verified.profile?.tenant_id;
    if (!targetTenantId) {
      return NextResponse.json({ error: 'A linked pastor or administrator account is required' }, { status: 403 });
    }
    const referenceParam = req.nextUrl.searchParams.get('reference')?.trim() || null;

    // Prefer whichever client can actually read the schema.
    const readers = [
      { label: 'service-role', client: adminSupabase, ready: isServiceRoleConfigured() },
      { label: 'RLS', client: supabase, ready: true },
    ];

    let wallet: any = null;
    let walletClient: any = adminSupabase;
    let walletReadFailed = false;
    for (const reader of readers) {
      if (!reader.ready) continue;
      const result = await readWalletWithColumnFallback((columns) =>
        reader.client.from('wallets').select(columns).eq('tenant_id', targetTenantId).maybeSingle(),
      );
      if (result.wallet) {
        wallet = result.wallet;
        walletClient = reader.client;
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

    const fetchTransaction = async (client: any) => {
      if (referenceParam) {
        // Try exact reference_code or reference (Na'jiki's reference)
        const { data: byRef } = await client
          .from('wallet_transactions')
          .select(TRANSACTION_COLUMNS)
          .eq('tenant_id', targetTenantId)
          .or(`reference_code.eq.${referenceParam},reference.eq.${referenceParam}`)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byRef) return byRef;
      }
      const { data: latest } = await client
        .from('wallet_transactions')
        .select(TRANSACTION_COLUMNS)
        .eq('tenant_id', targetTenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return latest ?? null;
    };

    // The poll in TopUpModal stops only on a terminal status, so an empty result
    // here is a stuck payment in the UI. Read both clients before concluding.
    const otherClient = walletClient === adminSupabase ? supabase : adminSupabase;
    let transaction: any = await fetchTransaction(walletClient);
    if (!transaction) {
      transaction = await fetchTransaction(otherClient);
      if (transaction) {
        console.warn('[Wallet Status] wallet_transactions was unreadable via the first client; found through the other — check its RLS policies');
      }
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
