/**
 * SMS text helpers for `church.sms_queue`.
 *
 * The deployed table has no `message` column: the SMS text lives in `body`.
 * Reads therefore accept either name (old dumps/snapshots used `message`),
 * while every write uses `body` and only columns that exist in production.
 */
export const SMS_QUEUE_MESSAGE_COLUMNS = ['body', 'message'] as const;

/** Read the SMS text from a queue row regardless of which column name exists. */
export function readQueueMessage(row: Record<string, unknown> | null | undefined): string | undefined {
  if (!row) return undefined;
  for (const column of SMS_QUEUE_MESSAGE_COLUMNS) {
    const value = row[column];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
