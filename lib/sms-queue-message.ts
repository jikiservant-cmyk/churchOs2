/**
 * SMS text column resolution for `church.sms_queue`.
 *
 * The deployed table stores the SMS text in `body`, while older schema
 * snapshots in this repository call the same field `message`. PostgREST
 * rejects any write that names a column missing from its schema cache
 * (PGRST204 / 42703) and also refuses reads of unknown columns, so the queue
 * code has to accept either name instead of assuming one.
 */
export const SMS_QUEUE_MESSAGE_COLUMNS = ['body', 'message'] as const;
export type SmsQueueMessageColumn = (typeof SMS_QUEUE_MESSAGE_COLUMNS)[number];

/** Read the SMS text from a queue row regardless of which column name exists. */
export function readQueueMessage(row: Record<string, unknown> | null | undefined): string | undefined {
  if (!row) return undefined;
  for (const column of SMS_QUEUE_MESSAGE_COLUMNS) {
    const value = row[column];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** True when PostgREST refused the statement because the named column is unknown. */
export function isUnknownColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  column: string,
): boolean {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  const detail = (error.message ?? '').toLowerCase();
  return detail.includes(column.toLowerCase()) &&
    (detail.includes('column') || detail.includes('schema cache'));
}
