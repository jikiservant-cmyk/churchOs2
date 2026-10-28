import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';

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

    const adminSupabase = await createAdminClient();
    const { data: profile, error: profileError } = await adminSupabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json({ error: 'Unable to verify church administrator access' }, { status: 500 });
    }
    if (!profile?.tenant_id || !['pastor', 'admin'].includes(profile.role)) {
      return NextResponse.json({ error: 'A linked pastor or administrator account is required' }, { status: 403 });
    }

    const churchIdParam = req.nextUrl.searchParams.get('church_id') || req.nextUrl.searchParams.get('churchId');
    if (churchIdParam && churchIdParam !== profile.tenant_id) {
      return NextResponse.json({ error: 'Access denied for this church workspace' }, { status: 403 });
    }
    const targetTenantId = profile.tenant_id;
    const referenceParam = req.nextUrl.searchParams.get('reference')?.trim() || null;

    // Fetch wallet (service role to bypass RLS, ensure we see balance even if RLS filtered)
    const { data: wallet, error: walletError } = await adminSupabase
      .from('wallets')
      .select('balance, sms_rate, tenant_id')
      .eq('tenant_id', targetTenantId)
      .maybeSingle();

    if (walletError) {
      console.error('[Wallet Status] Wallet lookup failed:', walletError.message);
      return NextResponse.json({ error: 'Unable to fetch wallet balance' }, { status: 500 });
    }

    const balanceUgx = wallet?.balance ?? 0;
    const smsRate = wallet?.sms_rate ?? 70;
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
