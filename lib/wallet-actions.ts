'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { normalizeUgPhone } from './utils';
import { parseWholeUgxAmount, SMS_TOPUP_MAX_UGX, SMS_TOPUP_MIN_UGX } from './money';
import crypto from 'crypto';
import { headers } from 'next/headers';
import { checkRateLimit, getRateLimitIp } from '@/lib/security/rate-limit';
import {
  buildChurchDonationPayment,
  buildChurchTopupPayment,
  createNajikiPayment,
  getNajikiConfig,
  NajikiApiError,
} from '@/lib/najiki/client';

// Format phone numbers for Na'jiki's payment API as digits-only E.164.
// Na'jiki normalizes provider-specific formatting internally.
function formatPhoneForNajiki(phone: string): string {
  const normalized = normalizeUgPhone(phone);
  if (normalized) {
    return normalized.replace('+', '');
  }
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `256${cleaned.slice(1)}`;
  }
  return cleaned;
}

// Najiki Payment Initiation
export async function initiateNajikiPayment(formData: FormData) {
  try {
    const churchId = String(formData.get('churchId') ?? '').trim();
    // F-06: never trust a client-supplied amount. Require whole UGX, not parseInt prefixes.
    const amount = parseWholeUgxAmount(formData.get('amount'), SMS_TOPUP_MIN_UGX, SMS_TOPUP_MAX_UGX);
    if (amount === null) {
      return { error: `Top-up must be a whole amount between ${SMS_TOPUP_MIN_UGX} and ${SMS_TOPUP_MAX_UGX} UGX` };
    }
    const phoneNumber = String(formData.get('phoneNumber') ?? '').trim();
    const normalizedPhone = normalizeUgPhone(phoneNumber);
    if (!normalizedPhone) return { error: 'Please enter a valid Ugandan phone number' };

    console.log('[Najiki] Initiation started');

    if (!churchId || !phoneNumber) {
      console.error('[Najiki] Missing or invalid required fields for payment');
      return { error: 'Missing or invalid required fields' };
    }

    // Verify authenticated user owns this church
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return { error: 'Unauthorized: authentication required' };
    }

    const { data: profile, error: profileError } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || profile.tenant_id !== churchId ||
        !['pastor', 'admin'].includes(profile.role)) {
      return { error: 'Access denied: a pastor or administrator for this church is required' };
    }

    const accountLimit = await checkRateLimit({ namespace: 'sms-topup-account', subject: user.id, limit: 10, windowSeconds: 60 * 60 });
    const phoneLimit = await checkRateLimit({ namespace: 'sms-topup-phone', subject: `${churchId}:${normalizedPhone}`, limit: 3, windowSeconds: 10 * 60 });
    const deniedLimit = !accountLimit.allowed ? accountLimit : phoneLimit;
    if (!accountLimit.allowed || !phoneLimit.allowed) {
      return { error: deniedLimit.unavailable ? 'Payment protection is temporarily unavailable.' : 'Too many payment attempts. Please wait before trying again.' };
    }

    // Fail fast with the exact variable names that are missing.
    try {
      getNajikiConfig();
    } catch (configError: any) {
      console.error('[Najiki] Payment credentials missing from environment.');
      return { error: configError?.message ?? 'Payment service not configured' };
    }

    // 0. Create admin client
    const supabaseAdmin = await createAdminClient();

    // 1. Fetch tenant code from database
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('code')
      .eq('id', churchId)
      .maybeSingle();

    const { data: churchData, error: churchError } = await supabaseAdmin
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', churchId)
      .maybeSingle();

    if (tenantError || churchError || !churchData) {
      console.error('[Najiki] Tenant/church lookup failed during top-up initiation.');
      return { error: 'Unable to verify church payment configuration' };
    }

    // Tenant identity must be church-specific; never route payments through a global fallback.
    const tenantCode = tenant?.code || churchData.slug;

    if (!tenantCode) {
      console.error('[Najiki] No tenant code available (neither in database nor env)');
      return { error: 'Tenant code not configured' };
    }

    // Fetch or create wallet to obtain wallet_id
    let { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('id')
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (walletError) return { error: 'Unable to verify church wallet' };
    if (!wallet) {
      const { error: tenantCreateError } = await supabaseAdmin
        .from('tenants')
        .upsert({ id: churchId, app_type: 'church', name: churchData.slug || 'Church' });
      if (tenantCreateError) return { error: 'Unable to initialize church payment account' };

      const { data: newWallet, error: walletCreateError } = await supabaseAdmin
        .from('wallets')
        .upsert({ tenant_id: churchId, balance: 0, sms_rate: 70, app_type: 'church' })
        .select('id')
        .single();
      if (walletCreateError) return { error: 'Unable to initialize church wallet' };
      wallet = newWallet;
    }

    if (!wallet?.id) {
      console.error('[Najiki] Wallet record missing for church:', churchId);
      return { error: 'Wallet record missing for church' };
    }

    // 2. Create a pending transaction in our DB with high-entropy cryptographic references
    const reference = `CHURCH-${crypto.randomUUID()}`;
    const idempotencyKey = `ik_church_${crypto.randomUUID()}`;

    const { error: txError } = await supabaseAdmin.from('wallet_transactions').insert({
      tenant_id: churchId,
      wallet_id: wallet.id,
      amount: amount,
      direction: 'credit',
      currency: 'UGX',
      type: 'sms_topup',
      description: `Najiki Top-up for ${phoneNumber}`,
      reference_code: reference,
      idempotency_key: idempotencyKey,
      status: 'pending',
      note: 'pending'
    });

    if (txError) {
      console.error('[Najiki] Failed to create pending transaction:', txError);
      return {
        error: `Database error: ${txError.message}`
      }
    }

    // 3. Format a validated Ugandan number for Na'jiki (digits-only E.164).
    const formattedPhone = normalizedPhone.replace('+', '');

    // 4. Call Najiki API — POST /api/payments
    //
    // Na'jiki generates its own `reference` and returns it as `reference` (not
    // `paymentIntentId`), so our own reference has to travel inside `metadata`
    // for the settlement webhook to find this row again. See
    // lib/najiki/webhook.ts → transactionLookupCandidates().
    let result;
    let requestDispatched = false;
    try {
      const paymentRequest = buildChurchTopupPayment({
        churchId,
        tenantCode,
        churchSlug: churchData?.slug,
        reference,
        idempotencyKey,
        amount,
        phoneNumber: formattedPhone,
      });

      // Avoid logging donor/member PII or opaque reconciliation metadata.
      console.log('[Najiki] Requesting payment through /api/payments:', {
        paymentTypeCode: paymentRequest.paymentTypeCode,
        currency: paymentRequest.currency,
        amount: paymentRequest.amount,
      });
      requestDispatched = true;
      result = await createNajikiPayment(paymentRequest);
    } catch (err: any) {
      // Only local validation failures or an explicit provider 4xx are known
      // rejections. A timeout, network error, or 5xx is ambiguous: Na'jiki may
      // have accepted the push, so keep the ledger pending.
      if (!requestDispatched || (err instanceof NajikiApiError && err.isClientError)) {
        console.warn('[Najiki] Provider rejected the payment request:', err.status, err.error);
        const { error: markFailedError } = await supabaseAdmin
          .from('wallet_transactions')
          .update({
            status: 'failed',
            raw_provider_response: { error: err.error, status: err.status }
          })
          .eq('reference_code', reference)
          .eq('status', 'pending');
        if (markFailedError) {
          console.error('[Najiki] Could not persist definitive payment rejection:', markFailedError.message);
          return { error: 'Payment request was rejected but its ledger status could not be saved' };
        }
        return { error: err.message || 'Payment request was rejected' };
      }
      console.warn('[Najiki] Payment request outcome is ambiguous; leaving ledger pending.');
      return {
        success: true,
        status: 'pending_confirmation',
        message: 'We are confirming whether the payment prompt was received. Do not submit another payment yet.',
        reference,
      };
    }

    console.log('[Najiki] Payment initiation response received.');

    // 5. Link the pending ledger row to the Na'jiki payment intent. The
    // database settlement RPC locates the wallet transaction by this exact
    // payment_intent_id and locates the intent by Na'jiki's `reference`.
    if (!result.paymentId || !result.reference) {
      console.error('[Najiki] Payment response omitted its intent ID or reference; leaving the ledger pending.');
      return {
        success: true,
        status: 'pending_confirmation',
        message: 'The payment request may have been received. We are waiting for a verifiable payment confirmation.',
        reference,
      };
    }

    const { error: linkError } = await supabaseAdmin
      .from('wallet_transactions')
      .update({
        payment_intent_id: result.paymentId,
        raw_provider_response: result,
        reference: result.reference,
      })
      .eq('reference_code', reference)
      .eq('status', 'pending');

    if (linkError) {
      // The provider may already have created the intent. Do not mark the
      // transaction failed; the signed callback will retry/reconcile it.
      console.error('[Najiki] Could not link the payment intent to the pending ledger row.');
      return {
        success: true,
        status: 'pending_confirmation',
        message: 'The payment request may have been received. We are waiting for a verifiable payment confirmation.',
        paymentId: result.paymentId,
        najikiReference: result.reference,
        reference,
      };
    }

    return {
      success: true,
      message: 'Payment prompt sent to your phone!',
      paymentId: result.paymentId,
      najikiReference: result.reference,
      status: result.status,
      reference,
    };
  } catch (err: any) {
    console.error('[Najiki] Unexpected error during initiation:', err);
    return { error: 'An unexpected error occurred: ' + (err.message || 'Unknown error') };
  }
}

export async function initiateDonationPayment(params: {
  churchId: string;
  amount: number;
  phoneNumber: string;
  category: string;
}) {
  if (!params || typeof params !== 'object') return { error: 'Invalid donation request.' };
  const { churchId, phoneNumber, category } = params;
  if (typeof churchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(churchId)) {
    return { error: 'A valid church is required for this donation.' };
  }
  if (typeof phoneNumber !== 'string' || phoneNumber.length > 32 || typeof category !== 'string') {
    return { error: 'Invalid donation details.' };
  }
  const DONATION_MIN = 500, DONATION_MAX = 10_000_000;
  const amount = parseWholeUgxAmount(params.amount, DONATION_MIN, DONATION_MAX);
  if (amount === null) {
    return { error: `Donation must be a whole amount between ${DONATION_MIN.toLocaleString()} and ${DONATION_MAX.toLocaleString()} UGX` };
  }
  if (!['tithe', 'offering', 'seed', 'building'].includes(category)) {
    return { error: 'Please select a valid giving category' };
  }

  const cleanPhone = normalizeUgPhone(phoneNumber);
  if (!cleanPhone) {
    return { error: 'Please enter a valid Ugandan phone number' };
  }

  const requestHeaders = await headers();
  const clientIp = getRateLimitIp(requestHeaders);
  if (clientIp === 'unknown' && process.env.NODE_ENV === 'production') {
    return { error: 'Payment protection is temporarily unavailable. Please try again later.' };
  }
  const ipLimit = await checkRateLimit({ namespace: 'public-donation-ip', subject: clientIp, limit: 10, windowSeconds: 60 * 60 });
  const phoneLimit = await checkRateLimit({ namespace: 'public-donation-phone', subject: `${churchId}:${cleanPhone}`, limit: 3, windowSeconds: 60 * 60 });
  const deniedLimit = !ipLimit.allowed ? ipLimit : phoneLimit;
  if (!ipLimit.allowed || !phoneLimit.allowed) {
    return { error: deniedLimit.unavailable ? 'Payment protection is temporarily unavailable.' : 'Too many payment attempts. Please wait before trying again.' };
  }

  // Fail closed if Na'jiki is unavailable or unconfigured. No downstream
  // payment credentials or direct-provider fallback are supported here.
  try {
    getNajikiConfig();
  } catch (error: any) {
    return { error: error?.message ?? "Na'jiki payment service is not configured" };
  }

  try {
    const supabaseAdmin = await createAdminClient();
    const { data: church, error: churchError } = await supabaseAdmin
      .schema('church')
      .from('churches')
      .select('id, name, slug')
      .eq('id', churchId)
      .maybeSingle();

    if (churchError) return { error: 'Unable to verify church payment configuration' };
    if (!church) return { error: 'Church not found' };

    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('code')
      .eq('id', churchId)
      .maybeSingle();
    if (tenantError) return { error: 'Unable to verify church payment configuration' };
    const tenantCode = tenant?.code || church.slug;
    if (!tenantCode) return { error: 'Tenant code not configured' };

    let { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('id')
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (walletError) return { error: 'Unable to verify church wallet' };
    if (!wallet?.id) {
      const { error: tenantCreateError } = await supabaseAdmin
        .from('tenants')
        .upsert({ id: churchId, app_type: 'church', name: church.slug || 'Church' });
      if (tenantCreateError) return { error: 'Unable to initialize church payment account' };
      const { data: newWallet, error: walletCreateError } = await supabaseAdmin
        .from('wallets')
        .upsert({ tenant_id: churchId, balance: 0, sms_rate: 70, app_type: 'church' })
        .select('id')
        .single();
      if (walletCreateError) return { error: 'Unable to initialize church wallet' };
      wallet = newWallet;
    }
    if (!wallet?.id) return { error: 'Wallet record missing for church' };

    const reference = `DON-${crypto.randomUUID()}`;
    const idempotencyKey = `ik_don_${crypto.randomUUID()}`;
    const { error: txError } = await supabaseAdmin.from('wallet_transactions').insert({
      tenant_id: churchId,
      wallet_id: wallet.id,
      amount,
      direction: 'credit',
      currency: 'UGX',
      type: 'DONATION',
      description: `Public ${category || 'giving'} donation from ${cleanPhone}`,
      reference_code: reference,
      idempotency_key: idempotencyKey,
      status: 'pending',
      note: `Category: ${category || 'general'}`,
    });

    if (txError) {
      console.error('[Donation] Failed to create pending transaction:', txError);
      return { error: 'Unable to initiate payment record' };
    }

    let requestDispatched = false;
    try {
      const paymentRequest = buildChurchDonationPayment({
        churchId,
        tenantCode,
        churchName: church.name,
        reference,
        idempotencyKey,
        amount,
        phoneNumber: formatPhoneForNajiki(cleanPhone),
        category,
      });
      requestDispatched = true;
      const result = await createNajikiPayment(paymentRequest);
      const { error: responseUpdateError } = await supabaseAdmin
        .from('wallet_transactions')
        .update({
          raw_provider_response: result,
          reference: result.reference ?? null,
        })
        .eq('reference_code', reference);
      if (responseUpdateError) {
        console.error('[Donation] Provider response could not be persisted; webhook can still reconcile by idempotency metadata.');
      }

      return { success: true, status: 'processing', message: 'Payment prompt sent to your phone! Please approve it on your handset.', reference };
    } catch (error: any) {
      if (!requestDispatched || (error instanceof NajikiApiError && error.isClientError)) {
        const { error: markFailedError } = await supabaseAdmin
          .from('wallet_transactions')
          .update({
            status: 'failed',
            raw_provider_response: {
              error: error?.message ?? String(error),
              status: error?.status ?? null,
            },
          })
          .eq('reference_code', reference)
          .eq('status', 'pending');
        if (markFailedError) {
          console.error('[Donation] Could not persist definitive payment rejection:', markFailedError.message);
          return { error: 'Payment request failed and its ledger status could not be saved' };
        }
        return { error: error?.message || 'Payment request was rejected' };
      }
      console.warn('[Donation] Payment request outcome is ambiguous; leaving ledger pending.');
      return {
        success: true,
        status: 'pending_confirmation',
        message: 'We are confirming whether the payment prompt was received. Do not submit another payment yet.',
        reference,
      };
    }
  } catch (error: any) {
    console.error('[Donation] Error:', error);
    return { error: 'Payment processing error: ' + (error.message || 'Unknown error') };
  }
}
