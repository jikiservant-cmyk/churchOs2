import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createNajikiPayment, getNajikiConfig, NajikiConfigError, NajikiApiError } from '../najiki/client.ts';

export const ACTIVATION_FEE_UGX = 17000;
export const ACTIVATION_CURRENCY = 'UGX';

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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
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
  provider = 'najiki'
}: {
  churchId: string;
  userId: string;
  phoneNumber: string;
  provider?: string;
}): Promise<{
  success: boolean;
  alreadyActive?: boolean;
  merchantReference?: string;
  providerTransactionId?: string;
  instructions?: string;
  error?: string;
}> {
  if (!churchId) {
    return { success: false, error: 'Unauthorized: church context required' };
  }

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

  // 4. Dispatch payment via Na'jiki / LivePay API client
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
      instructions = `Payment request logged for ${cleanPhone}. (Na'jiki API Key not yet set in environment — use simulation button to complete testing).`;
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

  const supabase = getAdminClient();

  // Attempt 1: Execute atomic PostgreSQL transaction RPC v2
  try {
    const { data: rpcResult, error: rpcError } = await supabase.rpc('activate_church_workspace_v2', {
      p_merchant_reference: merchantReference.trim(),
      p_provider: (provider || 'najiki').trim(),
      p_provider_transaction_id: providerTransactionId ? providerTransactionId.trim() : null,
      p_paid_amount: Number(paidAmount),
      p_currency: (currency || 'UGX').trim().toUpperCase(),
      p_provider_status: (status || 'SUCCESS').trim().toUpperCase()
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

  // Attempt 2: Direct fallback logic
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

  // Status verification
  const isSuccessful = ['SUCCESS', 'COMPLETED', 'PAID', 'CONFIRMED'].includes((status || '').toUpperCase());

  if (!isSuccessful) {
    console.warn('[Activation] Payment marked as failed by provider:', merchantReference, status);
    await supabase
      .schema('church')
      .from('activation_payments')
      .update({
        status: 'failed',
        failure_reason: `Provider reported status: ${status}`,
        provider_transaction_id: providerTransactionId || payment.provider_transaction_id
      })
      .eq('id', payment.id);

    return { success: false, error: `Payment failed with status: ${status}` };
  }

  // Exact amount & currency validation
  if (Number(paidAmount) !== ACTIVATION_FEE_UGX || (currency && currency.toUpperCase() !== ACTIVATION_CURRENCY)) {
    console.error('[Activation] Reconciliation mismatch:', {
      expected: { amount: ACTIVATION_FEE_UGX, currency: ACTIVATION_CURRENCY },
      received: { amount: paidAmount, currency }
    });

    await supabase
      .schema('church')
      .from('activation_payments')
      .update({
        status: 'failed',
        failure_reason: `Amount mismatch: expected UGX ${ACTIVATION_FEE_UGX}, received ${currency} ${paidAmount}`,
        provider_transaction_id: providerTransactionId || payment.provider_transaction_id
      })
      .eq('id', payment.id);

    return { success: false, error: 'Reconciliation error: payment amount mismatch' };
  }

  // Verification Success
  const now = new Date().toISOString();

  const { error: updatePaymentError } = await supabase
    .schema('church')
    .from('activation_payments')
    .update({
      status: 'paid',
      verified_at: now,
      provider_transaction_id: providerTransactionId || payment.provider_transaction_id
    })
    .eq('id', payment.id);

  if (updatePaymentError) {
    console.error('[Activation] Failed to update payment record:', updatePaymentError);
    return { success: false, error: 'Database update failed' };
  }

  const { error: updateChurchError } = await supabase
    .schema('church')
    .from('churches')
    .update({
      activation_status: 'active',
      activation_paid_at: now
    })
    .eq('id', payment.church_id);

  if (updateChurchError) {
    console.error('[Activation] Failed to activate church:', updateChurchError);
    return { success: false, error: 'Failed to update church activation status' };
  }

  console.log(`[Activation] Church ${payment.church_id} successfully activated via payment ${merchantReference}!`);

  return {
    success: true,
    churchId: payment.church_id,
    activated: true
  };
}
