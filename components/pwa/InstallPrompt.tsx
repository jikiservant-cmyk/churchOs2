'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { detectPlatform, isInstalledApp, type Platform } from '@/lib/pwa';

/**
 * Install prompt shown when the app opens.
 *
 * Three platform realities shape this component, and none of them can be
 * worked around:
 *
 *  1. Chrome/Edge fire `beforeinstallprompt` only once the app meets
 *     installability criteria, and the event can be triggered exactly once.
 *     We catch it, hold it, and call prompt() from our own button.
 *
 *  2. iOS Safari has no programmatic install at all. The only route is
 *     Share → Add to Home Screen, so iOS gets instructions instead of a button.
 *
 *  3. A page inside an iframe cannot be installed. In an embedded preview the
 *     event never fires, so this falls back to generic instructions rather
 *     than showing a dead button.
 *
 * "As a must": the overlay appears on every open until the app is installed.
 * Snoozing lasts only for the session (sessionStorage), which is wiped when
 * the tab or the installed app is closed — so the next open prompts again.
 * Once installed, it never appears again.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALLED_KEY = 'churchos:pwa-installed';
const SNOOZE_KEY = 'churchos:pwa-snoozed';

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform | 'unknown'>('unknown');
  const [canPrompt, setCanPrompt] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const [busy, setBusy] = useState(false);

  const deferred = useRef<BeforeInstallPromptEvent | null>(null);

  const rememberInstalled = useCallback(() => {
    try {
      localStorage.setItem(INSTALLED_KEY, '1');
    } catch {
      /* private mode: fall through, the display-mode check still works */
    }
    setVisible(false);
  }, []);

  useEffect(() => {
    // Already installed (launched from the home screen): never show.
    if (isInstalledApp(window)) {
      try {
        localStorage.setItem(INSTALLED_KEY, '1');
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      if (localStorage.getItem(INSTALLED_KEY) === '1') return;
      // Snoozed this session only — sessionStorage clears on close, so the
      // prompt returns on the next open, which is the requested behaviour.
      if (sessionStorage.getItem(SNOOZE_KEY) === '1') return;
    } catch {
      /* storage blocked: show the prompt rather than silently skipping */
    }

    setPlatform(detectPlatform(navigator));
    setEmbedded(window.self !== window.top);

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      deferred.current = event as BeforeInstallPromptEvent;
      setCanPrompt(true);
    };
    const onInstalled = () => rememberInstalled();

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // Wait out the splash screen (1400ms in SplashScreen.tsx) before covering
    // the UI. Showing this on top of the splash looks like two dialogs fighting.
    const timer = setTimeout(() => setVisible(true), 1700);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [rememberInstalled]);

  const install = useCallback(async () => {
    const event = deferred.current;
    if (!event) return;
    setBusy(true);
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      // The event is single-use whether accepted or dismissed.
      deferred.current = null;
      setCanPrompt(false);
      if (outcome === 'accepted') rememberInstalled();
      else snooze(setVisible);
    } finally {
      setBusy(false);
    }
  }, [rememberInstalled]);

  if (!visible) return null;

  const ios = platform === 'ios';

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-title"
      aria-describedby="install-body"
    >
      <div className="w-full max-w-sm rounded-3xl bg-[#F0E6D3] p-6 text-[#1E1208] shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#1E1208] text-lg font-bold text-[#F0E6D3]">
            ch
          </div>
          <div>
            <h2 id="install-title" className="text-lg font-semibold leading-tight">
              Install churchOs
            </h2>
            <p className="text-xs opacity-70">Add it to your home screen</p>
          </div>
        </div>

        <p id="install-body" className="mb-4 text-sm leading-relaxed opacity-80">
          churchOs works best installed. It opens full-screen, keeps the usher
          portal one tap away, and loads faster on a slow connection.
        </p>

        {ios ? (
          <ol className="mb-5 space-y-2 text-sm">
            <li className="flex gap-2">
              <span className="font-semibold">1.</span>
              <span>
                Tap the <strong>Share</strong> button in Safari&apos;s toolbar.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold">2.</span>
              <span>
                Scroll down and choose <strong>Add to Home Screen</strong>.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold">3.</span>
              <span>
                Tap <strong>Add</strong> — then reopen churchOs from your home
                screen.
              </span>
            </li>
          </ol>
        ) : canPrompt ? (
          <button
            type="button"
            onClick={install}
            disabled={busy}
            className="mb-3 w-full rounded-full bg-[#1E1208] px-6 py-3 text-sm font-semibold text-[#F0E6D3] disabled:opacity-60"
          >
            {busy ? 'Opening installer…' : 'Install app'}
          </button>
        ) : (
          <p className="mb-5 rounded-xl bg-[#1E1208]/5 p-3 text-xs leading-relaxed">
            {embedded
              ? 'This page is embedded in a preview frame, which browsers do not allow to be installed. Open churchOs in its own tab, then use the install icon in the address bar.'
              : 'Use your browser menu and choose “Install app” or “Add to Home screen”. In Chrome the install icon also appears in the address bar.'}
          </p>
        )}

        <button
          type="button"
          onClick={() => snooze(setVisible)}
          className="w-full rounded-full px-6 py-2 text-xs font-medium opacity-60 hover:opacity-90"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

// Snooze lasts until this tab/app closes. sessionStorage, not localStorage —
// the next open prompts again, which is the whole point.
function snooze(setVisible: (v: boolean) => void) {
  try {
    sessionStorage.setItem(SNOOZE_KEY, '1');
  } catch {
    /* ignore */
  }
  setVisible(false);
}
