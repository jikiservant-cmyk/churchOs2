import { NextRequest, NextResponse } from 'next/server';
import { confirmActivationPayment } from '@/lib/activation';
import { verifyNajikiWebhook } from '@/lib/najiki/webhook';

/**
 * Na'jiki/LivePay activation-payment webhook.
 *
 * ⚠️ FAIL CLOSED: this endpoint turns a webhook body into "the church paid
 * UGX 17,000". It MUST verify the provider signature on every request.
 *
 * The previous implementation only verified when a secret was configured and
 * silently skipped verification otherwise — meaning that on any deployment
 * without NAJIKI_WEBHOOK_SECRET, an anonymous attacker could POST
 * { reference, status: 'SUCCESS', amount: 17000 } and activate any church
 * for free. Verification is now mandatory; if no secret is available the
 * endpoint returns 503 (Na'jiki retries) instead of trusting the body.
 */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const headers = req.headers;

    // 1. Signature Verification — mandatory. The settlement webhook uses the
    //    same fallback (application webhook secret, else the API key), so we
    //    mirror it here.
    const webhookSecret =
      (process.env.NAJIKI_WEBHOOK_SECRET ?? '').trim() ||
      (process.env.NAJIKI_API_KEY ?? '').trim() ||
      (process.env.LIVEPAY_WEBHOOK_SECRET ?? '').trim();

    if (!webhookSecret) {
      console.error('[Activation Webhook] No provider webhook secret configured — refusing to process unverified payment');
      return NextResponse.json(
        { error: 'Webhook secret not configured' },
        { status: 503 }
      );
    }

    const verification = verifyNajikiWebhook({
      rawBody,
      headers,
      secret: webhookSecret,
    });

    if (!verification.ok) {
      console.warn(`[Activation Webhook] Rejected: ${verification.reason}`);
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }

    let payload: any = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    // Extract reference, amount, currency, status
    // Handle both Na'jiki/LivePay formats and generic standard formats
    const data = payload.data || payload;
    const merchantReference = data.reference || data.merchantReference || data.metadata?.merchantReference;
    const providerTransactionId = data.id || data.transactionId || data.paymentId || payload.id;
    const rawAmount = data.amount ?? payload.amount;
    const currency = String(data.currency || payload.currency || 'UGX').toUpperCase();

    // A callback with no explicit provider status is NOT treated as a success.
    // We pass the raw status straight through so the atomic RPC can classify
    // it (an unknown/blank status → no state change). The old code defaulted a
    // missing status to 'SUCCESS', which is a fail-open payment bug.
    const providerStatus = String(data.status || payload.status || '').trim().toUpperCase();

    if (!merchantReference) {
      console.warn('[Activation Webhook] Missing merchant reference in webhook:', payload);
      return NextResponse.json({ error: 'Missing merchant reference' }, { status: 400 });
    }

    if (rawAmount === undefined || rawAmount === null || Number.isNaN(Number(rawAmount))) {
      console.warn('[Activation Webhook] Missing or invalid amount in webhook:', payload);
      return NextResponse.json({ error: 'Missing payment amount' }, { status: 400 });
    }

    // The provider must match the provider recorded at initiation (the RPC
    // enforces this). Defaulting to 'najiki' when the body omits it matches
    // the only provider the activation path actually dispatches to.
    const provider = String(data.provider || payload.provider || 'najiki').trim() || 'najiki';

    // Process idempotent confirmation
    const outcome = await confirmActivationPayment({
      merchantReference,
      provider,
      providerTransactionId,
      paidAmount: Number(rawAmount),
      currency,
      status: providerStatus
    });

    if (!outcome.success) {
      console.warn('[Activation Webhook] Payment confirmation outcome failed:', outcome.error);
      // 422 = permanent for this payload shape; Na'jiki will not retry a 422.
      // Retriable provider-side blips should be 5xx.
      return NextResponse.json({ error: outcome.error }, { status: 422 });
    }

    return NextResponse.json({
      status: 'ok',
      message: 'Payment verified and church activation recorded',
      churchId: outcome.churchId
    });
  } catch (err: any) {
    console.error('[Activation Webhook] Fatal error processing webhook:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
