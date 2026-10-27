// Pure platform-detection helpers for the PWA install flow.
//
// Kept out of the component and free of direct DOM access so they can be
// unit-tested in Node. Platform detection is the part most likely to be wrong,
// because every browser lies about its user agent in a slightly different way.

export type Platform = 'ios' | 'chromium' | 'other';

/** The slice of `navigator` this module reads. */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}

/** The slice of `window` needed to decide whether we are already installed. */
export interface WindowLike {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: NavigatorLike & { standalone?: boolean };
}

const STANDALONE_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'];

/**
 * True when the page is running as an installed app rather than a browser tab.
 *
 * Three signals, because no single one covers every platform:
 *  - display-mode media query (the standard, supported by Chrome/Safari 14+);
 *  - navigator.standalone (iOS, which still does not implement display-mode
 *    reliably across versions);
 *  - window-controls-overlay (desktop install).
 */
export function isInstalledApp(win: WindowLike | undefined): boolean {
  if (!win) return false;
  if (win.navigator?.standalone === true) return true;
  if (typeof win.matchMedia !== 'function') return false;
  return STANDALONE_MODES.some((mode) => {
    try {
      return win.matchMedia?.(`(display-mode: ${mode})`).matches === true;
    } catch {
      return false;
    }
  });
}

export function detectPlatform(nav: NavigatorLike | undefined): Platform {
  if (!nav?.userAgent) return 'other';
  const ua = nav.userAgent;

  // iPadOS 13+ sends a desktop macOS user agent. The only reliable tell is
  // that it reports multiple touch points, which a Mac never does.
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  if (/iPhone|iPod/.test(ua) || isIPad) return 'ios';

  // Desktop Safari has no programmatic install either, so it follows the same
  // manual instructions as iOS. Checked before Chrome because Chrome's UA
  // also contains "Safari".
  if (/Chrome|Chromium|Edg\/|OPR\//.test(ua)) return 'chromium';
  if (/Safari/.test(ua)) return 'ios';

  return 'other';
}

/** Whether the install dialog should be shown at all. */
export function shouldOfferInstall(opts: {
  installed: boolean;
  snoozedThisSession: boolean;
  isStandalone: boolean;
}): boolean {
  if (opts.installed || opts.isStandalone) return false;
  if (opts.snoozedThisSession) return false;
  return true;
}
