import {
  classifyWalletSettlementResult,
  validateWalletPaymentAmount,
  type NajikiPaymentNotification,
  type WalletSettlementDecision,
} from './webhook.ts';

export interface WalletSettlementInput {
  db: any;
  notification: NajikiPaymentNotification;
  transaction: {
    tenant_id: string;
    amount: unknown;
    currency?: unknown;
    payment_intent_id?: string | null;
  };
  payload: unknown;
}

export type WalletSettlementResult =
  | { ok: true; settlement: Extract<WalletSettlementDecision, 'credited' | 'already_credited'> }
  | { ok: false; status: 409 | 422 | 500; error: string };

/** Verify the payment and require the database's atomic ledger-and-balance RPC. */
export async function settleWalletPayment({ db, notification, transaction, payload }: WalletSettlementInput): Promise<WalletSettlementResult> {
  const amountCheck = validateWalletPaymentAmount({
    receivedAmount: notification.amount,
    receivedCurrency: notification.currency,
    expectedAmount: transaction.amount,
    expectedCurrency: transaction.currency || 'UGX',
  });
  if (!amountCheck.ok) {
    return { ok: false, status: 422, error: 'Amount or currency mismatch' };
  }

  const reference = notification.reference.trim();
  const tenantId = transaction.tenant_id.trim();
  const paymentIntentId = notification.paymentIntentId.trim();
  const persistedAmount = Number(transaction.amount);

  if (!reference || !tenantId || !paymentIntentId) {
    return { ok: false, status: 422, error: 'Payment reference, tenant, and intent are required' };
  }
  if (transaction.payment_intent_id !== paymentIntentId) {
    return { ok: false, status: 409, error: 'Payment intent does not match the pending wallet transaction' };
  }

  const { data: rpcResult, error: rpcError } = await db.rpc('process_topup_webhook', {
    // The RPC resolves public.payment_intents.reference, not the app's
    // wallet_transactions.reference_code / churchReference.
    p_reference: reference,
    // The deployed function signature deliberately accepts tenant IDs as text.
    p_tenant_id: tenantId,
    // Pass the verified, persisted ledger amount; the RPC also checks it against
    // the payment intent before changing any wallet state.
    p_amount: persistedAmount,
    p_payload: payload,
  });
  if (rpcError) {
    return { ok: false, status: 500, error: 'Payment settlement is temporarily unavailable' };
  }

  const decision = classifyWalletSettlementResult(rpcResult);
  if (decision === 'credited' || decision === 'already_credited') {
    return { ok: true, settlement: decision };
  }
  return { ok: false, status: 500, error: 'Payment settlement result is unknown' };
}
