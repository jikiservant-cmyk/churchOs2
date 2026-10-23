import { normalizeUgPhone } from '@/lib/utils';
import { createAdminClient } from '@/lib/supabase/server';
import { sendNajikiSms } from '@/lib/najiki/client';

interface SendSMSParams {
  supabase: any;
  phoneNumber: string;
  message: string;
  churchId: string;
  idempotencyKey?: string;
  senderId?: string;
  balance: {
    balance: number;
    sms_rate: number;
  };
}

/** Send SMS exclusively through Na'jiki; never call an underlying SMS carrier. */
export async function sendSingleSMS({
  supabase,
  phoneNumber,
  message,
  churchId,
  idempotencyKey,
  senderId,
  balance,
}: SendSMSParams) {
  const finalPhone = normalizeUgPhone(phoneNumber);
  if (!finalPhone) {
    throw new Error(`Invalid phone number format: "${phoneNumber}"`);
  }

  const actualIdempotencyKey =
    idempotencyKey || `sms_${crypto.randomUUID()}`;

  const { data: initialLog, error: initialLogError } = await supabase
    .schema('church')
    .from('sms_logs')
    .insert({
      tenant_id: churchId,
      recipient_phone: finalPhone,
      body: message,
      status: 'PENDING',
      idempotency_key: actualIdempotencyKey,
    })
    .select('id')
    .single();

  if (initialLogError) {
    throw new Error(`Database Insert Error: ${initialLogError.message}`);
  }

  const logId = initialLog.id;

  try {
    // Na'jiki owns carrier selection, dispatch, retries and delivery callbacks.
    const result = await sendNajikiSms({
      to: finalPhone,
      message,
      from: senderId,
      idempotencyKey: actualIdempotencyKey,
    });

    if (result.success === false) {
      throw new Error(`Na'jiki refused the SMS: ${result.message || result.status || 'unknown error'}`);
    }

    // A repeated Na'jiki idempotency key represents an already-queued/billed
    // SMS. Do not debit this church a second time for the same message.
    if (!result.deduplicated) {
      const adminSupabase = await createAdminClient();
      const { data: debited, error: debitError } = await adminSupabase.rpc(
        'decrement_wallet_balance',
        { p_tenant_id: churchId, p_amount: balance.sms_rate },
      );

      if (debitError || !debited) {
        console.error('[SMS Actions] Atomic wallet deduction failed:', debitError);
        throw new Error('Insufficient SMS balance or wallet update failed');
      }

      const { data: walletData } = await adminSupabase
        .from('wallets')
        .select('id')
        .eq('tenant_id', churchId)
        .maybeSingle();

      const { error: ledgerError } = await adminSupabase.from('wallet_transactions').insert({
        tenant_id: churchId,
        wallet_id: walletData?.id,
        amount: -balance.sms_rate,
        type: 'SMS_SENT',
        description: `Sent 1 SMS to ${finalPhone} via Na'jiki`,
        reference_code: `SMS_${logId}_${Date.now()}`,
        status: 'success',
        idempotency_key: logId,
        product: 'sms',
        reference_id: logId,
      });

      if (ledgerError) {
        console.error('[SMS Actions] Ledger write failed after debit:', ledgerError);
        throw new Error(`Ledger write failed after debit: ${ledgerError.message}`);
      }
    }

    const { error: updateError } = await supabase
      .schema('church')
      .from('sms_logs')
      .update({
        status: 'Queued',
        message_provider_status: result.status,
        provider_message_id: result.smsId,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', logId);

    if (updateError) {
      throw new Error(`Failed to finalize SMS log: ${updateError.message}`);
    }

    return {
      success: true,
      messageId: result.smsId,
      status: result.status,
      deduplicated: result.deduplicated,
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await supabase
      .schema('church')
      .from('sms_logs')
      .update({
        status: 'FAILED',
        error_message: messageText,
        updated_at: new Date().toISOString(),
      })
      .eq('id', logId);

    throw error;
  }
}
