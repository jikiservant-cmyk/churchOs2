import { verifyNajikiWebhook } from '../najiki/webhook.ts';

export type ActivationWebhookVerification =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/** Fail closed: activation notifications are never trusted without a valid signature. */
export function verifyActivationWebhook(input: {
  rawBody: string;
  headers: Headers;
  secret: string | null | undefined;
}): ActivationWebhookVerification {
  if (!input.secret?.trim()) {
    return { ok: false, status: 503, error: 'Webhook secret not configured' };
  }

  const result = verifyNajikiWebhook(input);
  if (!result.ok) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }

  return { ok: true };
}
