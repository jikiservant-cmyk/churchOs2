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

/**
 * The route families that must never be interrupted by the install prompt.
 *
 * The usher portal is reached by a link a pastor sends to a volunteer — often through
 * WhatsApp or SMS, opened once, in a hurry, at a door. A full-screen "Install churchOs"
 * modal sitting between that volunteer and the check-in screen is not friction, it is a
 * support call to the pastor. Everything else in the product keeps the prompt exactly as
 * designed: it is the admin and pastor surfaces that are used daily and benefit from
 * living on the home screen.
 *
 * Matching is per path segment, never `startsWith('/usher')` and never a substring test:
 *  - `/c/ekero/usher` and `/c/ekero/usher/dashboard` are exempt;
 *  - `/c/ekero/usher-notes`, `/usher-admin`, `/c/usher/admin` are not, and the difference
 *    between those two shapes is the whole reason this is a function with tests rather
 *    than a regex someone has to re-derive at 3am.
 * The query string and hash are dropped first, because the invite links carry
 * `?church=<slug>`-style parameters and a matcher that ignores them would silently stop
 * matching the moment a pastor shares a slightly different link.
 */
export function isUsherPortalPath(pathOrUrl: string | undefined | null): boolean {
  if (!pathOrUrl) return false;
  const path = pathOrUrl.split('?')[0].split('#')[0];
  const segments = path.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) return false;

  // /c/{church_slug}/usher …
  if (segments[0] === 'c' && segments.length >= 3 && segments[2] === 'usher') return true;
  // /usher … — kept for the day the portal is reachable without a church prefix, so the
  // exemption does not have to be re-derived when someone adds that route.
  if (segments[0] === 'usher') return true;
  return false;
}

/** Whether the install dialog should be shown at all. */
export function shouldOfferInstall(opts: {
  installed: boolean;
  snoozedThisSession: boolean;
  isStandalone: boolean;
  /** True on the usher portal, where no install may be requested at all. */
  exemptPath?: boolean;
}): boolean {
  if (opts.exemptPath) return false;
  if (opts.installed || opts.isStandalone) return false;
  if (opts.snoozedThisSession) return false;
  return true;
}
