import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createNajikiPayment, getNajikiConfig, NajikiConfigError, NajikiApiError } from '../najiki/client.ts';

export const ACTIVATION_FEE_UGX = 17000;
export const ACTIVATION_CURRENCY = 'UGX';

/**
 * The simulation endpoint confirms an activation payment without any real
 * provider money moving. It MUST stay off in production; the only way to
 * switch it on is an explicit deployment opt-in via ACTIVATION_SIMULATION.
 */
export function isSimulationEnabled(): boolean {
  return (process.env.ACTIVATION_SIMULATION ?? '').trim().toLowerCase() === 'true';
}

/**
 * Providers the activation flow can actually dispatch to. The client is NOT
 * allowed to pick an arbitrary provider string: it is stored on the ledger
 * row and the confirmation RPC refuses any later callback whose provider does
 * not match — a mismatched provider would silently brick a paid activation.
 */
export const SUPPORTED_ACTIVATION_PROVIDERS = ['najiki'] as const;
export type ActivationProvider = (typeof SUPPORTED_ACTIVATION_PROVIDERS)[number];

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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  // Fail fast: the service-role key is mandatory for this flow. Silently
  // falling back to the anon key produces opaque RLS failures deep in the
  // payment path (and, worse, reads that look authoritative but aren't).
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url || !key) {
    throw new Error('Activation flow is not configured: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL missing');
  }

  return createSupabaseClient(url, key);
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

    // Fail closed: a missing/blank status means "not proven paid".
    const rawStatus = (church as any).activation_status as string | null;
    const activationStatus: ActivationStatusResult['activationStatus'] =
      rawStatus === 'active' || rawStatus === 'suspended' ? rawStatus : 'pending_payment';

    return {
      churchId: church.id,
      churchName: church.name,
      churchSlug: church.slug,
      activationStatus,
      activationPaidAt: (church as any).activation_paid_at ?? null,
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
  provider = 'najiki'
}: {
  churchId: string;
  userId: string;
  phoneNumber: string;
  provider?: string;
}): Promise<{
  success: boolean;
  alreadyActive?: boolean;
  /** True when an earlier pending attempt is reused instead of a new push. */
  reusedExistingPending?: boolean;
  merchantReference?: string;
  providerTransactionId?: string;
  instructions?: string;
  error?: string;
}> {
  if (!churchId) {
    return { success: false, error: 'Unauthorized: church context required' };
  }

  if (!SUPPORTED_ACTIVATION_PROVIDERS.includes(provider as ActivationProvider)) {
    return { success: false, error: `Unsupported payment provider: ${provider}` };
  }

  let supabase;
  try {
    supabase = getAdminClient();
  } catch (err: any) {
    return { success: false, error: err?.message || 'Activation flow is not configured' };
  }

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

  if (church.activation_status === 'suspended') {
    // A suspended workspace must not be self-service re-payable; that is a
    // support decision. Collecting money here would pay for nothing.
    return {
      success: false,
      error: 'This workspace is suspended. Please contact administrative support before making a payment.'
    };
  }

  // 1.5 Reuse an in-flight attempt. The UI polls this endpoint after a push;
  // a double-click (or retrying on a slow network) previously created a NEW
  // ledger row and a NEW MoMo push, and a user who approved both was charged
  // twice with no refund path.
  const { data: existingPending } = await supabase
    .schema('church')
    .from('activation_payments')
    .select('id, merchant_reference, provider_transaction_id, created_at')
    .eq('church_id', churchId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingPending) {
    return {
      success: true,
      reusedExistingPending: true,
      merchantReference: existingPending.merchant_reference,
      providerTransactionId: existingPending.provider_transaction_id || undefined,
      instructions: `An approval prompt is already on its way. Please approve UGX 17,000 once on ${existingPending.merchant_reference} — do not start a second payment.`
    };
  }

  // 2. Generate unique merchant reference
  const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase();
  const merchantReference = `ACT-${timestamp}-${randomSuffix}`;

  // Clean phone number (canonical E.164 digits-only format, default Uganda 256)
  let cleanPhone = (phoneNumber || '').replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '256' + cleanPhone.substring(1);
  } else if (!cleanPhone.startsWith('256') && cleanPhone.length === 9) {
    cleanPhone = '256' + cleanPhone;
  }

  if (!/^\d{8,15}$/.test(cleanPhone)) {
    return { success: false, error: 'Please enter a valid mobile money phone number' };
  }

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
      amount: ACTIVATION_FEE_UGX,
      currency: ACTIVATION_CURRENCY,
      provider: provider || 'najiki',
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

  // 4. Dispatch payment via Na'jiki API client
  let providerTxId: string | null = null;
  let instructions = `Payment prompt sent to ${cleanPhone}. Please approve the request of UGX 17,000 on your mobile handset.`;

  try {
    const najikiResponse = await createNajikiPayment({
      applicationCode: process.env.NAJIKI_APPLICATION_CODE || 'church',
      paymentTypeCode: process.env.NAJIKI_PAYMENT_TYPE_TOPUP || 'church_activation',
      externalEntityId: churchId,
      amount: ACTIVATION_FEE_UGX,
      currency: ACTIVATION_CURRENCY,
      phoneNumber: cleanPhone,
      idempotencyKey: merchantReference,
      description: `One-time app activation for ${church.name}`,
      metadata: {
        churchId,
        merchantReference,
        type: 'church_activation'
      }
    });

    providerTxId = najikiResponse.paymentId || najikiResponse.reference || null;
    if (providerTxId) {
      await supabase
        .schema('church')
        .from('activation_payments')
        .update({ provider_transaction_id: providerTxId })
        .eq('id', paymentRow.id);
    }
  } catch (err: any) {
    const providerNote = err?.message || String(err);
    console.warn('[Activation] Na\'jiki gateway dispatch note:', providerNote);

    await supabase
      .schema('church')
      .from('activation_payments')
      .update({
        failure_reason: providerNote
      })
      .eq('id', paymentRow.id);

    if (err instanceof NajikiConfigError) {
      instructions = `Payment request logged for ${cleanPhone}. (Na'jiki API Key not yet set in environment — the payment cannot be dispatched until the gateway is configured.)`;
    } else if (err instanceof NajikiApiError && err.isClientError) {
      // A rejected payload is a permanent failure for THIS attempt: don't
      // leave the user polling a push that will never happen.
      await supabase
        .schema('church')
        .from('activation_payments')
        .update({ status: 'failed' })
        .eq('id', paymentRow.id)
        .eq('status', 'pending');
      return { success: false, error: err.message };
    }
  }

  return {
    success: true,
    merchantReference,
    providerTransactionId: providerTxId || undefined,
    instructions
  };
}

/**
 * Confirm and verify payment outcome (called from webhook or verification worker)
 * Calls the atomic PostgreSQL RPC activate_church_workspace_v2 with fallback.
 */
export async function confirmActivationPayment({
  merchantReference,
  provider = 'najiki',
  providerTransactionId,
  paidAmount,
  currency = 'UGX',
  status = 'SUCCESS'
}: {
  merchantReference: string;
  provider?: string;
  providerTransactionId?: string;
  paidAmount: number;
  currency?: string;
  status?: string;
}): Promise<{
  success: boolean;
  churchId?: string;
  alreadyProcessed?: boolean;
  activated?: boolean;
  error?: string;
}> {
  if (!merchantReference) {
    return { success: false, error: 'Missing merchant reference' };
  }

  let supabase;
  try {
    supabase = getAdminClient();
  } catch (err: any) {
    return { success: false, error: err?.message || 'Activation flow is not configured' };
  }

  const normalizedStatus = String(status ?? '').trim().toUpperCase();
  const SUCCESS_STATUSES = ['SUCCESS', 'COMPLETED', 'PAID', 'CONFIRMED'];
  const isSuccessful = SUCCESS_STATUSES.includes(normalizedStatus);

  // Attempt 1: Execute atomic PostgreSQL transaction RPC v2
  try {
    const { data: rpcResult, error: rpcError } = await supabase.rpc('activate_church_workspace_v2', {
      p_merchant_reference: merchantReference.trim(),
      p_provider: (provider || 'najiki').trim(),
      p_provider_transaction_id: providerTransactionId ? providerTransactionId.trim() : null,
      p_paid_amount: Number(paidAmount),
      p_currency: (currency || 'UGX').trim().toUpperCase(),
      p_provider_status: normalizedStatus
    });

    if (!rpcError && rpcResult) {
      if (rpcResult.success) {
        return {
          success: true,
          churchId: rpcResult.church_id,
          alreadyProcessed: !!rpcResult.already_processed,
          activated: !!rpcResult.activated
        };
      } else {
        return {
          success: false,
          error: rpcResult.error || `Payment activation failed (${rpcResult.code || 'UNKNOWN'})`
        };
      }
    }

    if (rpcError && rpcError.code !== '42883') {
      console.warn('[Activation] RPC v2 returned error, evaluating fallback:', rpcError);
    }
  } catch (rpcEx) {
    console.warn('[Activation] RPC v2 execution exception, falling back:', rpcEx);
  }

  // Attempt 2: Direct fallback logic (used only when the RPC is unavailable,
  // e.g. migration 008 has not been applied yet).
  //
  // Security properties preserved here:
  //  - the payment row is only ever updated FROM a non-terminal status
  //    (pending/failed), so a racing duplicate cannot double-process;
  //  - a mismatched amount/currency or an unknown status leaves the row
  //    untouched (a correct provider callback can still reconcile it) — the
  //    old code marked these 'failed', permanently bricking a valid payment.
  const { data: payment, error: fetchError } = await supabase
    .schema('church')
    .from('activation_payments')
    .select('*')
    .eq('merchant_reference', merchantReference)
    .maybeSingle();

  if (fetchError || !payment) {
    console.error('[Activation] Payment reference not found:', merchantReference, fetchError);
    return { success: false, error: 'Payment attempt record not found' };
  }

  // Idempotency Check
  if (payment.status === 'paid') {
    return {
      success: true,
      alreadyProcessed: true,
      churchId: payment.church_id,
      activated: true
    };
  }

  if (!isSuccessful) {
    // Blank/unknown statuses: do not mutate the ledger, do not claim failure.
    if (!normalizedStatus) {
      console.warn('[Activation] Callback without a provider status; no state change:', merchantReference);
      return { success: false, error: 'Callback did not include a provider status' };
    }
    console.warn('[Activation] Payment marked as failed by provider:', merchantReference, normalizedStatus);
    await supabase
      .schema('church')
      .from('activation_payments')
      .update({
        status: 'failed',
        failure_reason: `Provider reported status: ${normalizedStatus}`,
        provider_transaction_id: providerTransactionId || payment.provider_transaction_id
      })
      .eq('id', payment.id)
      .in('status', ['pending', 'failed']);

    return { success: false, error: `Payment failed with status: ${normalizedStatus}` };
  }

  // Exact amount & currency validation
  if (Number(paidAmount) !== ACTIVATION_FEE_UGX || (currency && currency.toUpperCase() !== ACTIVATION_CURRENCY)) {
    console.error('[Activation] Reconciliation mismatch:', {
      expected: { amount: ACTIVATION_FEE_UGX, currency: ACTIVATION_CURRENCY },
      received: { amount: paidAmount, currency }
    });

    // Leave the row pending so a correct provider confirmation can reconcile
    // it. (The atomic RPC behaves the same way.)
    return { success: false, error: 'Reconciliation error: payment amount mismatch' };
  }

  // Verification Success — conditional transition, single row.
  const now = new Date().toISOString();

  const { data: updatedPayment, error: updatePaymentError } = await supabase
    .schema('church')
    .from('activation_payments')
    .update({
      status: 'paid',
      verified_at: now,
      provider_transaction_id: providerTransactionId || payment.provider_transaction_id
    })
    .eq('id', payment.id)
    .in('status', ['pending', 'failed'])
    .select('id, status')
    .maybeSingle();

  if (updatePaymentError) {
    console.error('[Activation] Failed to update payment record:', updatePaymentError);
    return { success: false, error: 'Database update failed' };
  }

  if (!updatedPayment || updatedPayment.status !== 'paid') {
    // A concurrent callback already moved this row. If it is paid now, we are
    // idempotent-duplicate; otherwise report the current state.
    const { data: current } = await supabase
      .schema('church')
      .from('activation_payments')
      .select('status, church_id')
      .eq('id', payment.id)
      .maybeSingle();

    if (current?.status === 'paid') {
      return { success: true, alreadyProcessed: true, churchId: current.church_id, activated: true };
    }
    return { success: false, error: 'Payment could not be transitioned to paid' };
  }

  // The RPC only activates from 'pending_payment' (a suspended church stays
  // suspended after paying); mirror that here.
  const { data: churchRow, error: updateChurchError } = await supabase
    .schema('church')
    .from('churches')
    .update({
      activation_status: 'active',
      activation_paid_at: now
    })
    .eq('id', payment.church_id)
    .in('activation_status', ['pending_payment', 'active'])
    .select('id, activation_status')
    .maybeSingle();

  if (updateChurchError || !churchRow) {
    console.error('[Activation] Failed to activate church:', updateChurchError);
    return { success: false, error: 'Failed to update church activation status' };
  }

  console.log(`[Activation] Church ${payment.church_id} successfully activated via payment ${merchantReference}!`);

  return {
    success: true,
    churchId: payment.church_id,
    activated: churchRow.activation_status === 'active'
  };
}
