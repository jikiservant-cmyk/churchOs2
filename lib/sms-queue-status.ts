export const SMS_QUEUE_STATUS = {
  pending: 'pending',
  processing: 'processing',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

export type SmsQueueStatus = (typeof SMS_QUEUE_STATUS)[keyof typeof SMS_QUEUE_STATUS];

/** Read legacy lowercase rows safely while all new writes use the DB contract's uppercase states. */
export function hasSmsQueueStatus(value: unknown, expected: SmsQueueStatus): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === expected.toLowerCase();
}
