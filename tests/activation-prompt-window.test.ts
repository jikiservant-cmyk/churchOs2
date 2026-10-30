import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIVATION_PROMPT_WINDOW_DEFAULT_MS,
  ACTIVATION_PROMPT_WINDOW_MAX_MS,
  ACTIVATION_PROMPT_WINDOW_MIN_MS,
  activationPromptDeadlineAt,
  describeActivationPromptCountdown,
  describeActivationPromptWindow,
  formatDuration,
  resolveActivationPromptWindowMs,
} from '../lib/activation-prompt-window.ts';

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Comment lines removed, because prose is allowed to quote a number that code must not. */
const code = (relative: string) =>
  source(relative)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const FIVE_MINUTES = 5 * 60 * 1000;

describe('Activation prompt window — the wait the pastor is told about', () => {
  test('the default is the five minutes that was asked for', () => {
    assert.equal(ACTIVATION_PROMPT_WINDOW_DEFAULT_MS, FIVE_MINUTES);
    assert.equal(resolveActivationPromptWindowMs('').windowMs, FIVE_MINUTES);
    assert.equal(resolveActivationPromptWindowMs(undefined).windowMs, FIVE_MINUTES);
    assert.equal(resolveActivationPromptWindowMs(null).windowMs, FIVE_MINUTES);
    assert.equal(resolveActivationPromptWindowMs('   ').windowMs, FIVE_MINUTES);
  });

  test('an override is honoured and announced as an override', () => {
    const resolved = resolveActivationPromptWindowMs('60000');
    assert.deepEqual(resolved, { windowMs: 60_000, overridden: true, rejected: null });
  });

  test('the boundaries are inclusive, so an operator can widen it to half an hour', () => {
    assert.equal(resolveActivationPromptWindowMs(String(ACTIVATION_PROMPT_WINDOW_MIN_MS)).windowMs, ACTIVATION_PROMPT_WINDOW_MIN_MS);
    assert.equal(resolveActivationPromptWindowMs(String(ACTIVATION_PROMPT_WINDOW_MAX_MS)).windowMs, ACTIVATION_PROMPT_WINDOW_MAX_MS);
    assert.notEqual(resolveActivationPromptWindowMs(String(ACTIVATION_PROMPT_WINDOW_MIN_MS - 1)).windowMs, ACTIVATION_PROMPT_WINDOW_MIN_MS - 1);
    assert.notEqual(resolveActivationPromptWindowMs(String(ACTIVATION_PROMPT_WINDOW_MAX_MS + 1)).windowMs, ACTIVATION_PROMPT_WINDOW_MAX_MS + 1);
  });

  test('anything that is not whole milliseconds is refused, not interpreted', () => {
    for (const junk of ['5m', '5 minutes', '-300000', '300000.5', '0', '0x10', ' 300_000 ', 'NaN', '1e9', '300000ms']) {
      const resolved = resolveActivationPromptWindowMs(junk);
      assert.equal(resolved.windowMs, FIVE_MINUTES, `"${junk}" must fall back to the default`);
      assert.equal(resolved.overridden, false, `"${junk}" must not be reported as an override`);
      assert.notEqual(resolved.rejected, null, `"${junk}" must be reported as rejected so the startup log says so`);
    }
  });

  test('a rejected value never throws: a typo in Vercel cannot take the payment screen down', () => {
    assert.doesNotThrow(() => resolveActivationPromptWindowMs('ten minutes please'));
    assert.equal(resolveActivationPromptWindowMs('ten minutes please').rejected, 'ten minutes please');
  });

  test('the deadline is the start plus the window, and nothing else', () => {
    assert.equal(activationPromptDeadlineAt(1_000, FIVE_MINUTES), 1_000 + FIVE_MINUTES);
    assert.equal(activationPromptDeadlineAt(0, 30_000), 30_000);
  });

  test('the countdown is what the screen renders, and it cannot go negative', () => {
    assert.deepEqual(describeActivationPromptCountdown(0, FIVE_MINUTES), { remainingMs: FIVE_MINUTES, expired: false, label: '5:00' });
    assert.deepEqual(describeActivationPromptCountdown(FIVE_MINUTES, FIVE_MINUTES), { remainingMs: 0, expired: true, label: '0:00' });
    assert.deepEqual(describeActivationPromptCountdown(FIVE_MINUTES + 1, FIVE_MINUTES), { remainingMs: 0, expired: true, label: '0:00' });
    assert.equal(describeActivationPromptCountdown(FIVE_MINUTES - 60_000, FIVE_MINUTES).label, '1:00');
    assert.equal(describeActivationPromptCountdown(FIVE_MINUTES - 59_000, FIVE_MINUTES).label, '0:59');
    assert.equal(describeActivationPromptCountdown(FIVE_MINUTES - 1, FIVE_MINUTES).label, '0:01');
    assert.equal(describeActivationPromptCountdown(FIVE_MINUTES - 1_500, FIVE_MINUTES).label, '0:02');
  });

  test('the label is built from the number, so the copy cannot drift from the setting', () => {
    assert.equal(describeActivationPromptWindow(FIVE_MINUTES), '5 minutes');
    assert.equal(describeActivationPromptWindow(60_000), '1 minute');
    assert.equal(describeActivationPromptWindow(3_600_000), '1 hour');
    assert.equal(describeActivationPromptWindow(2 * 3_600_000), '2 hours');
    assert.equal(describeActivationPromptWindow(5_400_000), '90 minutes');
    assert.equal(describeActivationPromptWindow(90_000), '90 seconds');
    assert.equal(describeActivationPromptWindow(30_000), '30 seconds');
  });

  test('formatDuration reads like a stopwatch', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(-5), '0:00');
    assert.equal(formatDuration(1_000), '0:01');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(3_601_000), '1:00:01');
  });
});

describe('The window is a promise about the wait, not a switch on the money', () => {
  test('the screen announces the resolved window instead of a literal', () => {
    const client = source('../components/activation/ActivationClient.tsx');
    assert.match(client, /promptWindowMs/, 'ActivationClient must take the window as a prop');
    assert.match(client, /promptWindowLabel/, 'ActivationClient must take the sentence as a prop');
    assert.ok(!/\b5 minutes\b/.test(code('../components/activation/ActivationClient.tsx')), 'the copy must be derived, not hardcoded — same lesson as the fee');
    assert.match(client, /setPromptDeadlineAt\(activationPromptDeadlineAt\(Date\.now\(\), promptWindowMs\)\)/);
    assert.match(client, /No confirmation after \{windowLabel\}/);
    assert.match(client, /Send the prompt again/);
    // A retry that comes back 429 must be seen: the error block in the pay form is
    // not rendered while the screen is polling, so the expired panel needs its own.
    const panel = client.slice(client.indexOf('No confirmation after'), client.indexOf('The network allows'));
    assert.match(panel, /\{errorMessage && \(/, 'a rejected retry would otherwise be silent');
    assert.match(panel, /\{!initiationAmbiguous && \(/, 'a retry while the first request is still live at the provider would be a second charge');
  });

  test('every way the wait can end also clears the deadline, and the poll is untouched', () => {
    const client = source('../components/activation/ActivationClient.tsx');
    const stops = [...client.matchAll(/setIsPolling\(false\)/g)];
    assert.equal(stops.length, 2, 'the screen stops polling in exactly two places: paid, and failed/cancelled');
    for (const stop of stops) {
      const nearby = client.slice(stop.index, stop.index + 220);
      assert.match(nearby, /setPromptDeadlineAt\(null\)/, 'a stopped wait must stop counting down too');
    }
    assert.match(client, /setInterval\(checkStatus, 3000\)/, 'the 3s status poll must keep running unchanged');
    assert.ok(!/clearInterval\(pollIntervalRef\.current\)\s*;\s*\}?\s*\n\s*if \(promptCountdown/.test(client));
  });

  test('no Date.now() during render — the clock is read in an effect', () => {
    const client = source('../components/activation/ActivationClient.tsx');
    const render = client.slice(client.lastIndexOf('\n  return ('));
    assert.ok(!/Date\.now\(\)/.test(render), 'impure reads in render break hydration and the react-compiler rules');
    assert.match(client, /const tick = \(\) => setPromptCountdown\(describeActivationPromptCountdown\(Date\.now\(\), promptDeadlineAt\)\);/);
  });

  test('the window travels from one server-side resolution', () => {
    const lib = source('../lib/activation/index.ts');
    assert.match(lib, /resolveActivationPromptWindowMs\(process\.env\.ACTIVATION_PROMPT_WINDOW_MS\)/);
    assert.match(lib, /export const ACTIVATION_PROMPT_WINDOW_MS = resolvedPromptWindow\.windowMs;/);
    assert.match(lib, /export const ACTIVATION_PROMPT_WINDOW_LABEL = describeActivationPromptWindow\(resolvedPromptWindow\.windowMs\);/);
    assert.match(lib, /ACTIVATION_PROMPT_WINDOW_MS=.*is not usable/, 'a rejected value must be logged, not swallowed');
    const page = source('../app/c/[church_slug]/admin/activation/page.tsx');
    assert.match(page, /promptWindowMs=\{ACTIVATION_PROMPT_WINDOW_MS\}/);
    assert.match(page, /promptWindowLabel=\{ACTIVATION_PROMPT_WINDOW_LABEL\}/);
    assert.ok(!/ACTIVATION_PROMPT_WINDOW/.test(source('../lib/activation-fee.ts')), 'the fee module must stay about money');
  });

  test('nothing about the window can gate, bill or route anyone', () => {
    for (const file of ['../lib/activation-gate.ts', '../lib/auth-destination.ts', '../lib/auth-actions.ts']) {
      assert.ok(!/PROMPT_WINDOW|promptWindow/.test(source(file)), `${file} must not learn about the wait`);
    }
    for (const route of [
      '../app/api/church/activation/start/route.ts',
      '../app/api/church/activation/status/route.ts',
    ]) {
      assert.ok(!/PROMPT_WINDOW|promptWindow|prompt-window/.test(source(route)), `${route} must not reject a late payment`);
    }
    // The settlement path is the one place where an expired-looking wait could do
    // real damage (a paid church left locked), so it must stay untouched too.
    assert.ok(!/PROMPT_WINDOW|promptWindow/.test(source('../app/api/webhooks/najiki/route.ts')), 'the webhook must not expire anything');
  });

  test('the module is client-safe: no environment reads of its own', () => {
    const body = code('../lib/activation-prompt-window.ts');
    assert.ok(!/process\.env/.test(body), 'the environment is read once, on the server, and passed in — never in a module the client bundle imports');
    assert.ok(!/'use server'/.test(body), 'a shared pure module cannot be server-only');
  });

  test('the variable is documented where operators look', () => {
    assert.match(source('../.env.example'), /ACTIVATION_PROMPT_WINDOW_MS=""/);
  });
});
