import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { normalizeUgPhone } from '../utils.ts';
import { createNajikiPayment, najikiApplicationCode, najikiPaymentTypeCode, NajikiApiError } from '../najiki/client.ts';

export const ACTIVATION_FEE_UGX = 17000;
export const ACTIVATION_CURRENCY = 'UGX';
export const ACTIVATION_PLAN_PRICES = {
  standard: ACTIVATION_FEE_UGX,
} as const;

export interface ActivationStatusResult {
  churchId: string;
  churchName: string;
  churchSlug: string;
  activationStatus: 'active' | 'pending_payment' | 'suspended';
  activationPaidAt: string | null;
  isActive: boolean;
  latestPayment?: {
    id: string;
    amount: number;
    currency: string;
    provider: string;
    merchantReference: string;
    status: string;
    createdAt: string;
    verifiedAt: string | null;
    failureReason: string | null;
  } | null;
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Church activation requires server-side Supabase service-role configuration');
  }
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Fetch current church activation status from trusted server-side client
 */
export async function getChurchActivationStatus(churchId: string): Promise<ActivationStatusResult | null> {
  if (!churchId) return null;

  try {
    const supabase = getAdminClient();

    const { data: church, error: churchError } = await supabase
      .schema('church')
      .from('churches')
      .select('id, name, slug, activation_status, activation_paid_at')
      .eq('id', churchId)
      .maybeSingle();

    if (churchError || !church) {
      console.error('[Activation] Error fetching church status:', churchError);
      return null;
    }

    const { data: latestPayment } = await supabase
      .schema('church')
      .from('activation_payments')
      .select('*')
      .eq('church_id', churchId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const activationStatus = (church.activation_status || 'pending_payment') as 'active' | 'pending_payment' | 'suspended';

    return {
      churchId: church.id,
      churchName: church.name,
      churchSlug: church.slug,
      activationStatus,
      activationPaidAt: church.activation_paid_at,
      isActive: activationStatus === 'active',
      latestPayment: latestPayment ? {
        id: latestPayment.id,
        amount: latestPayment.amount,
        currency: latestPayment.currency,
        provider: latestPayment.provider,
        merchantReference: latestPayment.merchant_reference,
        status: latestPayment.status,
        createdAt: latestPayment.created_at,
        verifiedAt: latestPayment.verified_at,
        failureReason: latestPayment.failure_reason
      } : null
    };
  } catch (err) {
    console.error('[Activation] getChurchActivationStatus exception:', err);
    return null;
  }
}

/**
 * Initiate an activation payment for the authenticated user's church
 */
export async function startActivationPayment({
  churchId,
  userId,
  phoneNumber,
  plan
}: {
  churchId: string;
  userId: string;
  phoneNumber: string;
  plan?: string;
}): Promise<{
  success: boolean;
  alreadyActive?: boolean;
  merchantReference?: string;
  providerTransactionId?: string;
  status?: 'pending_confirmation';
  instructions?: string;
  error?: string;
}> {
  if (!churchId) {
    return { success: false, error: 'Unauthorized: church context required' };
  }

  const selectedPlan = 'standard' as const;
  const chosenAmount = ACTIVATION_PLAN_PRICES[selectedPlan];
  const supabase = getAdminClient();

  // 1. Verify church exists and check if already active
  const { data: church, error: churchError } = await supabase
    .schema('church')
    .from('churches')
    .select('id, name, slug, activation_status')
    .eq('id', churchId)
    .maybeSingle();

  if (churchError || !church) {
    return { success: false, error: 'Church workspace not found' };
  }

  if (church.activation_status === 'active') {
    return {
      success: true,
      alreadyActive: true,
      instructions: 'Church is already fully active.'
    };
  }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('code')
    .eq('id', churchId)
    .maybeSingle();
  const tenantCode = tenant?.code || church.slug;
  if (!tenantCode) {
    return { success: false, error: 'Na\'jiki tenant code is not configured for this church' };
  }

  // 2. Generate unique merchant reference
  const merchantReference = `ACT-${randomUUID()}`;

  // Require a valid Ugandan mobile number before creating a ledger attempt.
  const normalizedPhone = normalizeUgPhone(phoneNumber || '');
  if (!normalizedPhone) return { success: false, error: 'Please enter a valid Ugandan mobile number' };
  const cleanPhone = normalizedPhone.replace('+', '');

  // 3. Record pending payment attempt in database ledger
  let validUserId: string | null = null;
  if (userId) {
    const { data: userExists } = await supabase.auth.admin.getUserById(userId).catch(() => ({ data: { user: null } }));
    if (userExists?.user) {
      validUserId = userId;
    }
  }

  const { data: paymentRow, error: insertError } = await supabase
    .schema('church')
    .from('activation_payments')
    .insert({
      church_id: churchId,
      amount: chosenAmount,
      currency: ACTIVATION_CURRENCY,
      provider: 'najiki',
      merchant_reference: merchantReference,
      status: 'pending',
      initiated_by: validUserId
    })
    .select()
    .single();

  if (insertError) {
    console.error('[Activation] Failed to insert payment attempt:', insertError);
    return { success: false, error: 'Failed to record payment attempt in ledger' };
  }

  // 4. Initiate the payment through Na'jiki only
  let providerTxId: string | null = null;
  let instructions = `Payment prompt sent to ${cleanPhone}. Please approve the request of UGX ${chosenAmount.toLocaleString('en-US')} on your mobile handset.`;

  let requestDispatched = false;
  try {
    const paymentRequest = {
      applicationCode: najikiApplicationCode(),
      tenantCode,
      paymentTypeCode: najikiPaymentTypeCode('activation'),
      externalEntityId: churchId,
      amount: chosenAmount,
      currency: ACTIVATION_CURRENCY,
      phoneNumber: cleanPhone,
      idempotencyKey: merchantReference,
      description: `${selectedPlan.toUpperCase()} plan activation for ${church.name}`,
      metadata: {
        churchId,
        tenantCode,
        merchantReference,
        plan: selectedPlan,
        type: 'church_activation'
      }
    };

    requestDispatched = true;
    const najikiResponse = await createNajikiPayment(paymentRequest);
    // `paymentId` is Na'jiki's own intent ID. The settlement RPC's
    // provider_transaction_id is the downstream provider ID that arrives later
    // as webhook `providerPaymentId`; persisting the intent ID here would make
    // the successful callback look like a conflicting transaction.
    providerTxId = najikiResponse.providerPaymentId?.trim() || null;
    if (providerTxId) {
      await supabase
        .schema('church')
        .from('activation_payments')
        .update({ provider_transaction_id: providerTxId })
        .eq('id', paymentRow.id);
    }
  } catch (err: any) {
    const providerNote = err?.message || String(err);
    const definitiveRejection = !requestDispatched || (err instanceof NajikiApiError && err.isClientError);

    if (!definitiveRejection) {
      console.warn('[Activation] Payment initiation outcome is ambiguous; leaving attempt pending.');
      return {
        success: true,
        status: 'pending_confirmation',
        merchantReference,
        instructions: 'We are confirming whether the payment prompt was received. Do not start another payment yet.',
      };
    }

    console.warn('[Activation] Na\'jiki definitively rejected payment initiation:', providerNote);
    const { error: failUpdateError } = await supabase
      .schema('church')
      .from('activation_payments')
      .update({ status: 'failed', failure_reason: providerNote })
      .eq('id', paymentRow.id)
      .eq('status', 'pending');

    if (failUpdateError) {
      console.error('[Activation] Could not persist payment rejection:', failUpdateError.message);
      return { success: false, merchantReference, error: 'Payment request was rejected but its status could not be saved' };
    }
    return { success: false, merchantReference, error: `Na'jiki payment initiation failed: ${providerNote}` };
  }

  return {
    success: true,
    merchantReference,
    providerTransactionId: providerTxId || undefined,
    instructions
  };
}

/**
 * Confirm and verify payment outcome. Called only by the signed Na'jiki webhook.
 * Settles exclusively through the atomic PostgreSQL RPC activate_church_workspace_v2.
 */
export async function confirmActivationPayment({
  merchantReference,
  providerTransactionId,
  paidAmount,
  currency = 'UGX',
  status = 'SUCCESS'
}: {
  merchantReference: string;
  providerTransactionId?: string;
  paidAmount: number;
  currency?: string;
  status?: string;
}): Promise<{
  success: boolean;
  churchId?: string;
  alreadyProcessed?: boolean;
  activated?: boolean;
  retryable?: boolean;
  error?: string;
}> {
  if (!merchantReference) {
    return { success: false, error: 'Missing merchant reference' };
  }

  // Settle only through the atomic RPC. A direct-table fallback could mark the
  // payment paid without activating the church (or the reverse) and cannot
  // preserve the ledger's idempotency guarantees. This must use the service-role
  // client because only service_role is granted execute on the public RPC.
  try {
    const supabase = getAdminClient();
    const { data: rpcResult, error: rpcError } = await supabase.rpc('activate_church_workspace_v2', {
      p_merchant_reference: merchantReference.trim(),
      p_provider: 'najiki',
      p_provider_transaction_id: providerTransactionId ? providerTransactionId.trim() : null,
      p_paid_amount: Number(paidAmount),
      p_currency: (currency || 'UGX').trim().toUpperCase(),
      p_provider_status: (status || 'SUCCESS').trim().toUpperCase()
    });

    if (rpcError) {
      console.error('[Activation] Atomic settlement RPC failed; no fallback was attempted:', rpcError.message);
      return { success: false, retryable: true, error: 'Atomic activation settlement is temporarily unavailable' };
    }
    if (!rpcResult || typeof rpcResult !== 'object') {
      console.error('[Activation] Atomic settlement RPC returned no structured result.');
      return { success: false, retryable: true, error: 'Atomic activation settlement returned an invalid result' };
    }

    if (rpcResult.success) {
      return {
        success: true,
        churchId: rpcResult.church_id,
        alreadyProcessed: !!rpcResult.already_processed,
        activated: !!rpcResult.activated
      };
    }

    // The RPC persists terminal provider failures; acknowledge those business
    // outcomes so Na'jiki does not retry them indefinitely.
    if (
      ['FAILED', 'EXPIRED', 'CANCELLED', 'CANCELED'].includes(String(status).toUpperCase()) &&
      ['FAILED', 'CANCELLED', 'CANCELED', 'PROVIDER_FAILED'].includes(String(rpcResult.code).toUpperCase())
    ) {
      return {
        success: true,
        churchId: rpcResult.church_id,
        alreadyProcessed: String(rpcResult.code).toUpperCase() === 'PROVIDER_FAILED',
        activated: false,
      };
    }

    return {
      success: false,
      error: rpcResult.error || `Payment activation failed (${rpcResult.code || 'UNKNOWN'})`
    };
  } catch (rpcError: any) {
    console.error('[Activation] Atomic settlement RPC threw:', rpcError?.message ?? rpcError);
    return { success: false, retryable: true, error: 'Atomic activation settlement is temporarily unavailable' };
  }
}
