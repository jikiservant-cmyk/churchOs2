import { NextRequest, NextResponse } from 'next/server';
import { confirmActivationPayment } from '@/lib/activation';
import { verifyNajikiWebhookSignature } from '@/lib/najiki/webhook';

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const headers = req.headers;

    // 1. Signature Verification (if secret configured)
    const webhookSecret = process.env.NAJIKI_WEBHOOK_SECRET || process.env.LIVEPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const isSignatureValid = verifyNajikiWebhookSignature({
        rawBody,
        headers,
        secret: webhookSecret,
      });

      if (!isSignatureValid) {
        console.warn('[Activation Webhook] Invalid signature received');
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
      }
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
    const paidAmount = Number(data.amount || payload.amount);
    const currency = (data.currency || payload.currency || 'UGX').toUpperCase();
    const providerStatus = (data.status || payload.status || data.event || payload.event || 'SUCCESS').toUpperCase();

    if (!merchantReference) {
      console.warn('[Activation Webhook] Missing merchant reference in webhook:', payload);
      return NextResponse.json({ error: 'Missing merchant reference' }, { status: 400 });
    }

    const provider = (data.provider || payload.provider || 'najiki').trim();

    // Process idempotent confirmation
    const outcome = await confirmActivationPayment({
      merchantReference,
      provider,
      providerTransactionId,
      paidAmount,
      currency,
      status: providerStatus
    });

    if (!outcome.success) {
      console.warn('[Activation Webhook] Payment confirmation outcome failed:', outcome.error);
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
