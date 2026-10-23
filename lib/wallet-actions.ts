'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { normalizeUgPhone } from './utils';
import crypto from 'crypto';
import {
  buildChurchDonationPayment,
  buildChurchTopupPayment,
  createNajikiPayment,
  getNajikiConfig,
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
    const churchId = formData.get('churchId') as string;
    // F-06: never trust a client-supplied amount. Price server-side and cap it.
    const rawAmount = parseInt(String(formData.get('amount') ?? ''), 10);
    const TOPUP_MIN = 1_000, TOPUP_MAX = 2_000_000;
    if (!Number.isFinite(rawAmount) || rawAmount < TOPUP_MIN || rawAmount > TOPUP_MAX) {
      return { error: `Top-up must be between ${TOPUP_MIN} and ${TOPUP_MAX} UGX` };
    }
    const amount = rawAmount; // amount now means UGX received, nothing else
    const phoneNumber = formData.get('phoneNumber') as string;

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

    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || profile.tenant_id !== churchId) {
      return { error: 'Access denied: cannot initiate payment for another church' };
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
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('code')
      .eq('id', churchId)
      .maybeSingle();

    const { data: churchData } = await supabaseAdmin
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', churchId)
      .maybeSingle();

    // Resolve tenantCode: use tenant.code first, then church.slug, then fallback to env var
    let tenantCode = tenant?.code || churchData?.slug || process.env.NAJIKI_TENANT_CODE;

    if (!tenantCode) {
      console.error('[Najiki] No tenant code available (neither in database nor env)');
      return { error: 'Tenant code not configured' };
    }

    // Fetch or create wallet to obtain wallet_id
    let { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('id')
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (!wallet) {
      await supabaseAdmin
        .from('tenants')
        .upsert({ id: churchId, app_type: 'church', name: churchData?.slug || 'Church' });

      const { data: newWallet } = await supabaseAdmin
        .from('wallets')
        .upsert({ tenant_id: churchId, balance: 0, sms_rate: 70, app_type: 'church' })
        .select('id')
        .single();

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
      type: 'TOPUP',
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

    // 3. Format phone number to E.164 or standard international format
    const formattedPhone = formatPhoneForNajiki(phoneNumber);

    // 4. Call Najiki API — POST /api/payments
    //
    // Na'jiki generates its own `reference` and returns it as `reference` (not
    // `paymentIntentId`), so our own reference has to travel inside `metadata`
    // for the settlement webhook to find this row again. See
    // lib/najiki/webhook.ts → transactionLookupCandidates().
    const paymentRequest = buildChurchTopupPayment({
      churchId,
      tenantCode,
      churchSlug: churchData?.slug,
      reference,
      idempotencyKey,
      amount,
      phoneNumber: formattedPhone,
    });

    console.log('[Najiki] Sending request to /api/payments:', JSON.stringify({ ...paymentRequest, phoneNumber: 'REDACTED' }));

    let result;
    try {
      result = await createNajikiPayment(paymentRequest);
    } catch (err: any) {
      // Surface Na'jiki's own error text — a rejected payload must never look
      // like a success to the caller.
      console.error('[Najiki] API Error Response:', err?.message ?? err);
      await supabaseAdmin
        .from('wallet_transactions')
        .update({
          status: 'failed',
          raw_provider_response: { error: err?.message ?? String(err), status: err?.status ?? null }
        })
        .eq('reference_code', reference);

      return { error: err?.message || 'Payment request failed' };
    }

    console.log('[Najiki] API Response:', JSON.stringify(result));

    // 5. Update transaction with Najiki response.
    // `reference` is Na'jiki's own payment reference; `reference_code` stays ours.
    if (result.paymentId) {
      await supabaseAdmin
        .from('wallet_transactions')
        .update({ 
          raw_provider_response: result,
          reference: result.reference ?? null
        })
        .eq('reference_code', reference);
    }

    return {
      success: true,
      message: 'Payment prompt sent to your phone!',
      paymentId: result.paymentId,
      najikiReference: result.reference,
      status: result.status,
      reference: reference
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
  const { churchId, amount, phoneNumber, category } = params;
  const DONATION_MIN = 500, DONATION_MAX = 10_000_000;
  if (!Number.isFinite(amount) || amount < DONATION_MIN || amount > DONATION_MAX) {
    return { error: `Donation must be between ${DONATION_MIN.toLocaleString()} and ${DONATION_MAX.toLocaleString()} UGX` };
  }

  const cleanPhone = normalizeUgPhone(phoneNumber);
  if (!cleanPhone) {
    return { error: 'Please enter a valid Ugandan phone number' };
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
    const { data: church } = await supabaseAdmin
      .schema('church')
      .from('churches')
      .select('id, name, slug')
      .eq('id', churchId)
      .maybeSingle();

    if (!church) return { error: 'Church not found' };

    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('code')
      .eq('id', churchId)
      .maybeSingle();
    const tenantCode = tenant?.code || church.slug || process.env.NAJIKI_TENANT_CODE;
    if (!tenantCode) return { error: 'Tenant code not configured' };

    let { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('id')
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (!wallet?.id) {
      await supabaseAdmin
        .from('tenants')
        .upsert({ id: churchId, app_type: 'church', name: church.slug || 'Church' });
      const { data: newWallet } = await supabaseAdmin
        .from('wallets')
        .upsert({ tenant_id: churchId, balance: 0, sms_rate: 70, app_type: 'church' })
        .select('id')
        .single();
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

    try {
      const result = await createNajikiPayment(paymentRequest);
      await supabaseAdmin
        .from('wallet_transactions')
        .update({
          raw_provider_response: result,
          reference: result.reference ?? null,
        })
        .eq('reference_code', reference);

      return { success: true, message: 'Payment prompt sent to your phone!', reference };
    } catch (error: any) {
      await supabaseAdmin
        .from('wallet_transactions')
        .update({
          status: 'failed',
          raw_provider_response: {
            error: error?.message ?? String(error),
            status: error?.status ?? null,
          },
        })
        .eq('reference_code', reference);
      return { error: error?.message || 'Payment request failed' };
    }
  } catch (error: any) {
    console.error('[Donation] Error:', error);
    return { error: 'Payment processing error: ' + (error.message || 'Unknown error') };
  }
}
