import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * ⚠️ LEGACY / DISABLED.
 *
 * This endpoint used to "initiate" payments through provider stubs
 * (pesapal/flutterwave/xente in lib/payments/payment-service.ts) that only
 * returned fake payment URLs — no provider was ever called, and no
 * `wallet_transactions` ledger row was ever created, so the settlement
 * webhooks had nothing to reconcile against.
 *
 * The live top-up path is the Na'jiki flow (lib/wallet-actions.ts →
 * initiateNajikiPayment), which records a pending ledger row BEFORE
 * dispatching and reconciles via the signed Na'jiki webhook.
 *
 * The route is kept (not deleted) so any stale client linking to it gets an
 * explicit, actionable error instead of a silent fake checkout.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json(
    {
      error:
        'This top-up endpoint is no longer available. Wallet top-ups are processed through the Na\'jiki payment gateway — please use the Top Up Wallet option in your dashboard.',
    },
    { status: 501 }
  );
}
