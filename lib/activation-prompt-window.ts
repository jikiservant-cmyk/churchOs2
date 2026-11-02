/**
 * How long the activation screen waits for the prompt to be approved on the
 * handset, and what it says while it waits.
 *
 * WHY THIS EXISTS
 * Before this file the screen had no notion of time at all: `ActivationClient`
 * polled `/api/church/activation/status` every 3 seconds forever, and the only
 * two ways out were the ledger turning `active` or turning `failed`/`cancelled`.
 * A pastor who never saw the prompt on the phone therefore stared at
 * "Waiting for PIN confirmation..." indefinitely, with no idea whether the
 * request was still live, and no way to ask for another one without reloading
 * the page. This module gives that wait a length and an ending.
 *
 * WHAT THE WAIT IS NOT
 * It is not a lock-out and it is not a cancel. Nothing here talks to Na'jiki,
 * settles or fails a ledger row, or stops the status poll. The provider owns the
 * real timeout — an intent left `processing` is re-polled by the dispatcher and
 * can still come back `paid` after this window closes, so the screen keeps
 * listening after it expires. If it does come back, the church is activated, and
 * that is the correct outcome: money that arrived is money that counts.
 *
 * WHY A VARIABLE AND NOT A LITERAL
 * Same reasoning as the fee: the window that matters in production is a Vercel
 * setting, so changing it back to "no announced deadline" is a delete, not a
 * deploy. The default is 5 minutes, which is also the freshness window the
 * inbound webhook signature is accepted for (see NAJIKI_INTEGRATION.md), so the
 * number the pastor sees matches the number the provider is working to.
 */

/** The announced window: 5 minutes. */
export const ACTIVATION_PROMPT_WINDOW_DEFAULT_MS = 5 * 60 * 1000;

/**
 * Anything below half a minute is a stopwatch, not a deadline, and anything above
 * half an hour is a false promise about a USSD prompt. A rejected value falls
 * back to the default rather than throwing — a bad env var must not take the
 * payment screen down.
 */
export const ACTIVATION_PROMPT_WINDOW_MIN_MS = 30 * 1000;
export const ACTIVATION_PROMPT_WINDOW_MAX_MS = 30 * 60 * 1000;

export interface PromptWindowResolution {
  windowMs: number;
  /** True when an environment override was actually used. */
  overridden: boolean;
  /** The raw value that was rejected, if any, so the caller can warn. */
  rejected: string | null;
}

/**
 * `ACTIVATION_PROMPT_WINDOW_MS` — whole milliseconds, no sign, no separators.
 * Deliberately strict for the same reason the fee is strict: `Number("5m")` is
 * 5 minutes to a human reading a typo and 0 ms to a machine.
 *
 * The raw value is a parameter, never a read of `process.env` inside this file:
 * the same module is imported by the client component, and a client bundle that
 * quietly saw `undefined` here would disagree with the server about how long the
 * wait is. `lib/activation/index.ts` reads the environment once and passes it in.
 */
export function resolveActivationPromptWindowMs(
  raw: string | undefined | null,
): PromptWindowResolution {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') {
    return { windowMs: ACTIVATION_PROMPT_WINDOW_DEFAULT_MS, overridden: false, rejected: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { windowMs: ACTIVATION_PROMPT_WINDOW_DEFAULT_MS, overridden: false, rejected: trimmed };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < ACTIVATION_PROMPT_WINDOW_MIN_MS || parsed > ACTIVATION_PROMPT_WINDOW_MAX_MS) {
    return { windowMs: ACTIVATION_PROMPT_WINDOW_DEFAULT_MS, overridden: false, rejected: trimmed };
  }
  return { windowMs: parsed, overridden: true, rejected: null };
}

/** The moment the pastor should be told the prompt has probably gone cold. */
export function activationPromptDeadlineAt(startedAtMs: number, windowMs: number): number {
  return startedAtMs + windowMs;
}

export interface PromptCountdown {
  /** Never negative, so it is safe to render. */
  remainingMs: number;
  expired: boolean;
  /** `m:ss` under a minute or `h:mm:ss`, for the ticking line on the screen. */
  label: string;
}

/**
 * Pure so it can be tested without a clock and without React: pass `nowMs` and
 * `deadlineAt`, get what to render.
 */
export function describeActivationPromptCountdown(
  nowMs: number,
  deadlineAt: number,
): PromptCountdown {
  const remaining = deadlineAt - nowMs;
  if (remaining <= 0) return { remainingMs: 0, expired: true, label: '0:00' };
  return { remainingMs: remaining, expired: false, label: formatDuration(remaining) };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * "5 minutes" / "90 seconds" / "1 hour" — the sentence the UI quotes, built from
 * the window instead of hardcoded, so the copy cannot drift from the setting the
 * way the fee used to drift from the ledger.
 */
export function describeActivationPromptWindow(windowMs: number): string {
  const minutes = windowMs / 60_000;
  if (Number.isInteger(minutes)) {
    if (minutes === 1) return '1 minute';
    if (minutes >= 60 && Number.isInteger(minutes / 60)) {
      const hours = minutes / 60;
      return hours === 1 ? '1 hour' : `${hours} hours`;
    }
    return `${minutes} minutes`;
  }
  const seconds = Math.round(windowMs / 1000);
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
