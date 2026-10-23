/**
 * POST /api/najiki/webhook   (also mounted at /api/webhooks/najiki)
 *
 * Receives Na'jiki Finance's outbound notifications:
 *
 *   1. Payment settlement — `{ paymentIntentId, reference, status, amount,
 *      currency, providerPaymentId, failureReason, externalEntityId, metadata }`
 *      for status ∈ success | failed | expired | cancelled.
 *   2. SMS delivery — `{ eventType: 'SMS_DELIVERY_UPDATE', smsId, reference,
 *      status, providerId, recipient, applicationCode }`.
 *
 * Both are signed identically (src/lib/notification-signature.ts in
 * najiki-finance2):
 *
 *   X-Najiki-Timestamp: <unix ms>
 *   X-Najiki-Signature: t=<unix ms>,v=<hmac>
 *   v = HMAC-SHA256(secret, "<timestamp>.<raw request body>")
 *
 * The previous implementation looked for `x-najiki-signature: sha256=<hmac of
 * the raw body>` with no timestamp — a scheme Na'jiki does not implement — so
 * every notification was rejected with 403 and no wallet was ever credited by
 * Na'jiki. Verification now lives in lib/najiki/webhook.ts and is unit-tested
 * against Na'jiki's own signer.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import {
  verifyNajikiWebhook,
  classifyNajikiWebhook,
  activationMerchantReference,
  parsePaymentNotification,
  parseSmsDeliveryNotification,
  transactionLookupCandidates,
  notificationTenantCode,
  notificationChurchId,
  planPaymentReceiptSms,
} from '@/lib/najiki/webhook';
import { settleWalletPayment } from '@/lib/najiki/settlement';
import { sendSingleSMS } from '@/lib/sms-actions';
import { confirmActivationPayment } from '@/lib/activation';

export const dynamic = 'force-dynamic';

function getServiceDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/** Statuses Na'jiki reports as a terminal failure. */
const TERMINAL_FAILURE_STATUSES = ['failed', 'expired', 'cancelled'];

export async function POST(request: Request) {
  try {
    return await handlePost(request)
  } catch (err: any) {
    // A 500 tells Na'jiki to retry, which is what we want for a transient
    // failure — and each handler below is idempotent (the atomic wallet RPC
    // locks the ledger row; receipt SMS uses its own idempotency key). It must
    // never be an unhandled rejection.
    console.error('[Najiki Webhook] Unhandled error:', err?.message ?? err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  // 1. Bound request size before parsing; signature verification still uses the exact bytes.
  const MAX_WEBHOOK_BYTES = 64 * 1024;
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  if (!request.body) return NextResponse.json({ error: 'Missing request body' }, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const rawBody = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  );

  // 2. Verify the signature (fail closed, replay-protected).
  const secret = process.env.NAJIKI_WEBHOOK_SECRET || process.env.NAJIKI_API_KEY;

  if (!secret) {
    console.error('[Najiki Webhook] NAJIKI_WEBHOOK_SECRET / NAJIKI_API_KEY not set — rejecting webhook');
    return NextResponse.json({ error: 'Webhook secret unconfigured' }, { status: 500 });
  }

  const verification = verifyNajikiWebhook({ rawBody, headers: request.headers, secret });
  if (!verification.ok) {
    console.error(`[Najiki Webhook] Rejected: ${verification.reason}`);
    return NextResponse.json({ error: 'Forbidden', reason: verification.reason }, { status: 403 });
  }

  // 3. Parse the payload (only after authentication).
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (parseErr) {
    console.error('[Najiki Webhook] Failed to parse JSON:', parseErr);
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const kind = classifyNajikiWebhook(payload);

  if (kind === 'sms_delivery') {
    return handleSmsDelivery(payload);
  }

  if (kind === 'payment') {
    return handlePaymentNotification(payload);
  }

  // Do not acknowledge an unknown signed shape: a payment payload contract
  // change must be surfaced for reconciliation rather than silently dropped.
  console.warn('[Najiki Webhook] Unrecognised signed payload shape; refusing to acknowledge it.');
  return NextResponse.json({ error: 'Unsupported webhook payload' }, { status: 400 });
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS delivery reports
// ─────────────────────────────────────────────────────────────────────────────

async function handleSmsDelivery(payload: any) {
  const notification = parseSmsDeliveryNotification(payload)!;
  const { smsId, reference: smsRef, status: smsStatus } = notification;

  console.log(`[Najiki Webhook] SMS Delivery Update for ${smsRef || smsId}: ${smsStatus}`);

  // Validate before use — these values arrive in the request body.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Na'jiki returns opaque non-UUID smsId values; accept only URL/filter-safe IDs.
  const SAFE_SMS_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const KEY_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
  const safeId = typeof smsId === 'string' && (UUID_RE.test(smsId) || SAFE_SMS_ID_RE.test(smsId)) ? smsId : null;
  const safeRef = typeof smsRef === 'string' && KEY_RE.test(smsRef) ? smsRef : null;

  if (!safeId && !safeRef) {
    console.warn('[Najiki Webhook] SMS delivery update has no usable id/reference.');
    return NextResponse.json({ error: 'Malformed SMS delivery notification' }, { status: 400 });
  }

  const normalizedProviderStatus = typeof smsStatus === 'string' ? smsStatus.trim().toLowerCase() : '';
  if (!['delivered', 'failed'].includes(normalizedProviderStatus)) {
    console.warn('[Najiki Webhook] Ignoring unsupported SMS delivery status:', normalizedProviderStatus || '(empty)');
    return NextResponse.json({ error: 'Unsupported SMS delivery status' }, { status: 422 });
  }

  const db = getServiceDb();
  const normalisedStatus = normalizedProviderStatus;

  const updateObj: Record<string, unknown> = {
    status: normalisedStatus,
    message_provider_status: smsStatus,
    updated_at: new Date().toISOString(),
  };
  if (safeId) {
    // Keep Na'jiki's own smsId as the stable callback key. providerId is an
    // opaque downstream carrier ID and is not the ID sent in future callbacks.
    updateObj.provider_message_id = safeId;
    updateObj.najiki_sms_id = safeId;
  }
  if (safeRef) updateObj.najiki_reference = safeRef;

  const orConditions = [
    safeId ? `provider_message_id.eq.${safeId}` : null,
    safeId ? `najiki_sms_id.eq.${safeId}` : null,
    safeRef ? `najiki_reference.eq.${safeRef}` : null,
  ].filter(Boolean).join(',');

  // Resolve owner(s) first, then keep every update tenant-scoped.
  const { data: owners, error: ownerError } = await db
    .schema('church')
    .from('sms_logs')
    .select('tenant_id')
    .or(orConditions)
    .limit(10);

  if (ownerError) {
    console.error('[Najiki Webhook] Failed to resolve SMS delivery owner:', ownerError.message);
    return NextResponse.json({ error: 'Delivery update could not be recorded' }, { status: 500 });
  }

  for (const owner of owners ?? []) {
    const { error: updateError } = await db.schema('church').from('sms_logs').update(updateObj)
      .eq('tenant_id', owner.tenant_id)
      .or(orConditions);
    if (updateError) {
      console.error('[Najiki Webhook] Failed to record SMS delivery update:', updateError.message);
      return NextResponse.json({ error: 'Delivery update could not be recorded' }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true, eventType: 'SMS_DELIVERY_UPDATE' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment settlement
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaymentNotification(payload: any) {
  const notification = parsePaymentNotification(payload);
  if (!notification || !notification.paymentIntentId || !notification.status) {
    console.warn('[Najiki Webhook] Malformed payment notification; required identifiers/status missing.');
    return NextResponse.json({ error: 'Malformed payment notification' }, { status: 400 });
  }

  const { reference, status, amount } = notification;
  const db = getServiceDb();

  // Activation payments are settled here too: there is no separate public
  // callback that can activate a church. This branch runs only after the
  // shared Na'jiki signature verification above succeeds.
  if (notification.metadata.type === 'church_activation') {
    const merchantReference = activationMerchantReference(notification);
    if (!merchantReference) {
      return NextResponse.json({ error: 'Missing activation merchant reference' }, { status: 400 });
    }

    const { data: activationPayment, error: activationLookupError } = await db
      .schema('church')
      .from('activation_payments')
      .select('church_id, provider')
      .eq('merchant_reference', merchantReference)
      .maybeSingle();
    if (activationLookupError) {
      console.error('[Najiki Webhook] Activation ledger lookup failed:', activationLookupError.message);
      return NextResponse.json({ error: 'Activation settlement is temporarily unavailable' }, { status: 500 });
    }
    if (!activationPayment) {
      return NextResponse.json({ error: 'Activation ledger transaction not found' }, { status: 500 });
    }
    if (activationPayment.provider !== 'najiki') {
      return NextResponse.json({ error: 'Activation provider mismatch' }, { status: 403 });
    }

    const churchId = notificationChurchId(notification);
    if (!churchId || churchId !== activationPayment.church_id) {
      console.error('[Najiki Webhook] Activation church identity mismatch; rejecting settlement.');
      return NextResponse.json({ error: 'Activation church mismatch' }, { status: 403 });
    }
    const tenantCode = notificationTenantCode(notification);
    if (!tenantCode) {
      return NextResponse.json({ error: 'Activation tenant code missing' }, { status: 422 });
    }
    const { data: tenant, error: tenantError } = await db
      .from('tenants')
      .select('id')
      .eq('code', tenantCode.trim())
      .maybeSingle();
    if (tenantError) {
      return NextResponse.json({ error: 'Activation tenant verification is temporarily unavailable' }, { status: 500 });
    }
    if (!tenant || tenant.id !== activationPayment.church_id) {
      return NextResponse.json({ error: 'Activation tenant mismatch' }, { status: 403 });
    }

    if (String(status).toLowerCase() === 'success' &&
        (!Number.isSafeInteger(amount) || (amount ?? 0) <= 0 || !notification.currency?.trim())) {
      return NextResponse.json({ error: 'Activation payment amount and currency are required' }, { status: 422 });
    }

    const outcome = await confirmActivationPayment({
      merchantReference,
      providerTransactionId: notification.providerPaymentId || notification.paymentIntentId,
      paidAmount: Number(amount ?? 0),
      currency: notification.currency || 'UGX',
      status: String(status).toUpperCase(),
    });

    if (!outcome.success) {
      return NextResponse.json(
        { error: outcome.error || 'Activation settlement failed' },
        { status: outcome.retryable ? 500 : 422 },
      );
    }
    return NextResponse.json({ received: true, type: 'church_activation' });
  }

  // Na'jiki never echoes our own reference back at the top level, so the
  // lookup order matters: our reference (carried in metadata.churchReference),
  // then Na'jiki's reference (persisted on the row when it was created), then
  // the idempotency key.
  let tx: any = null;
  for (const candidate of transactionLookupCandidates(notification)) {
    const { data, error: lookupError } = await db
      .from('wallet_transactions')
      .select('*')
      .eq(candidate.column, candidate.value)
      .maybeSingle();
    if (lookupError) {
      console.error('[Najiki Webhook] Ledger lookup failed:', lookupError.message);
      return NextResponse.json({ error: 'Payment settlement is temporarily unavailable' }, { status: 500 });
    }
    if (data) {
      tx = data;
      break;
    }
  }

  if (!tx) {
    console.warn('[Najiki Webhook] Signed payment notification did not match a ledger transaction.');
    // Retry: the ledger row may be temporarily unavailable/replicated late.
    return NextResponse.json({ error: 'Payment ledger transaction not found' }, { status: 500 });
  }

  // Prefer Na'jiki's resolved top-level tenantCode; fall back to our metadata
  // for compatibility with older notifications.
  const tenantCode = notificationTenantCode(notification);
  if (!tenantCode) {
    return NextResponse.json({ error: 'Payment tenant code missing' }, { status: 422 });
  }
  const { data: tenant, error: tenantError } = await db
    .from('tenants')
    .select('id')
    .eq('code', tenantCode.trim())
    .maybeSingle();

  if (tenantError) {
    console.error('[Najiki Webhook] Tenant verification failed:', tenantError.message);
    return NextResponse.json({ error: 'Payment settlement is temporarily unavailable' }, { status: 500 });
  }
  if (!tenant || tenant.id !== tx.tenant_id) {
    console.error('[Najiki Webhook] Tenant identity mismatch; rejecting settlement.');
    return NextResponse.json({ error: 'Tenant mismatch' }, { status: 403 });
  }

  // Cross-check the church id we sent as `externalEntityId` / metadata.churchId
  // against the row we are about to credit.
  const churchId = notificationChurchId(notification);
  if (!churchId || churchId !== tx.tenant_id) {
    console.error('[Najiki Webhook] Church identity mismatch; rejecting settlement.');
    return NextResponse.json({ error: 'Tenant mismatch' }, { status: 403 });
  }

  // Persist the provider reference only after identity checks have passed.
  if (reference && tx.reference !== reference) {
    const { error: referenceError } = await db.from('wallet_transactions')
      .update({ reference })
      .eq('id', tx.id);
    if (referenceError) {
      console.error('[Najiki Webhook] Failed to persist provider reference:', referenceError.message);
      return NextResponse.json({ error: 'Payment settlement is temporarily unavailable' }, { status: 500 });
    }
  }

  // ── Terminal failure ───────────────────────────────────────────────────────
  if (TERMINAL_FAILURE_STATUSES.includes(String(status).toLowerCase())) {
    const { error: failureUpdateError } = await db
      .from('wallet_transactions')
      .update({
        status: 'failed',
        raw_provider_response: payload,
        note: `Na'jiki ${status}: ${notification.failureReason ?? 'no reason given'}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', tx.id)
      .eq('status', 'pending');

    if (failureUpdateError) {
      console.error('[Najiki Webhook] Could not persist terminal payment failure:', failureUpdateError.message);
      return NextResponse.json({ error: 'Payment status could not be recorded' }, { status: 500 });
    }
    console.log(`[Najiki Webhook] Payment ${status} received for ledger transaction.`);
    return NextResponse.json({ received: true });
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (String(status).toLowerCase() === 'success') {
    // Wallet status and balance must change in the same database transaction;
    // there is deliberately no manual non-atomic fallback.
    const settlement = await settleWalletPayment({
      db,
      notification,
      transaction: tx,
      payload,
    });
    if (!settlement.ok) {
      console.error('[Najiki Webhook] Wallet settlement refused:', settlement.error);
      return NextResponse.json({ error: settlement.error }, { status: settlement.status });
    }

    revalidatePath('/', 'layout');
    console.log('[Najiki Webhook] Wallet settlement confirmed:', settlement.settlement, 'amount:', tx.amount);
    await sendPaymentReceipt(db, notification, tx);
    return NextResponse.json({ received: true, settlement: settlement.settlement });
  }

  // Na'jiki only notifies on terminal statuses; anything else is unexpected.
  console.warn('[Najiki Webhook] Non-terminal payment status received:', status);
  return NextResponse.json({ received: true });
}

/**
 * Send the donor an SMS receipt — strictly after the payment has been confirmed
 * and the wallet credited.
 *
 * Never throws: the payment is already recorded, and a failed receipt must not
 * make Na'jiki retry the whole notification (which would re-run the credit).
 */
async function sendPaymentReceipt(db: any, notification: any, tx: any) {
  try {
    const { data: church } = await db
      .schema('church')
      .from('churches')
      .select('name, sender_id')
      .eq('id', tx.tenant_id)
      .maybeSingle();

    const plan = planPaymentReceiptSms({
      notification,
      transactionType: tx.type,
      churchName: church?.name ?? null
    });

    if (!plan) return;

    // The Edge dispatcher checks balance through the explicitly verified wallet
    // mapping and keeps the receipt queued if the church needs a top-up.

    const senderId = church?.sender_id?.trim() || '';

    await sendSingleSMS({
      supabase: db,
      phoneNumber: plan.to,
      message: plan.message,
      churchId: tx.tenant_id,
      idempotencyKey: plan.idempotencyKey,
      senderId
    });

    console.log(`[Najiki Webhook] Receipt SMS queued for ${plan.to} (${plan.idempotencyKey})`);
  } catch (err: any) {
    console.error('[Najiki Webhook] Receipt SMS failed (payment is unaffected):', err?.message ?? err);
  }
}
