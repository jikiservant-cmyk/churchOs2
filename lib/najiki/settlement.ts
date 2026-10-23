import {
  classifyWalletSettlementResult,
  validateWalletPaymentAmount,
  type NajikiPaymentNotification,
  type WalletSettlementDecision,
} from './webhook.ts';

export interface WalletSettlementInput {
  db: any;
  notification: NajikiPaymentNotification;
  transaction: { tenant_id: string; amount: unknown; currency?: unknown; reference_code?: string | null; reference?: string | null };
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

  const { data: wallet, error: walletError } = await db
    .from('wallets')
    .select('id')
    .eq('tenant_id', transaction.tenant_id)
    .maybeSingle();
  if (walletError || !wallet) {
    return { ok: false, status: 500, error: 'Wallet settlement is temporarily unavailable' };
  }

  const { data: rpcResult, error: rpcError } = await db.rpc('process_topup_webhook', {
    p_reference: transaction.reference_code || transaction.reference || notification.reference,
    p_tenant_id: transaction.tenant_id,
    p_amount: transaction.amount,
    p_payload: payload,
  });
  if (rpcError) {
    return { ok: false, status: 500, error: 'Payment settlement is temporarily unavailable' };
  }

  const decision = classifyWalletSettlementResult(rpcResult);
  if (decision === 'credited' || decision === 'already_credited') {
    return { ok: true, settlement: decision };
  }
  if (decision === 'conflict') {
    return { ok: false, status: 409, error: 'Payment transaction is in a conflicting state' };
  }
  return { ok: false, status: 500, error: 'Payment settlement result is unknown' };
}
