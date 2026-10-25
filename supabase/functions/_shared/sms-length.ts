const GSM_BASIC = new Set(Array.from(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ' +
  ' !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿' +
  'abcdefghijklmnopqrstuvwxyzäöñüà',
));
const GSM_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

export const MAX_SMS_SEGMENTS = 4;

/** Count billable SMS segments for GSM-7 or UCS-2 text. */
export function smsSegmentCount(message: string): number {
  if (!message) return 0;
  let gsmUnits = 0;
  let isGsm = true;
  for (const character of message) {
    if (GSM_BASIC.has(character)) gsmUnits += 1;
    else if (GSM_EXTENSION.has(character)) gsmUnits += 2;
    else {
      isGsm = false;
      break;
    }
  }
  const units = isGsm ? gsmUnits : message.length; // UCS-2 cost is UTF-16 code units.
  const singleSegmentCapacity = isGsm ? 160 : 70;
  const concatenatedCapacity = isGsm ? 153 : 67;
  return units <= singleSegmentCapacity ? 1 : Math.ceil(units / concatenatedCapacity);
}

export function isSmsWithinSegmentLimit(message: string): boolean {
  return smsSegmentCount(message) <= MAX_SMS_SEGMENTS;
}
