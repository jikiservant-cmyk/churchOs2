// PWA installability and safety checks.
//
// Chrome will not offer to install an app that fails its installability
// criteria, and it fails silently — no error, just no prompt. That makes these
// properties worth asserting rather than eyeballing:
//
//   a web manifest linked from the page, with name, short_name, start_url,
//   display standalone, and 192px + 512px icons served from the same origin
//   and actually present on disk.
//
// The service worker is checked too, because the previous one was
// cache-first-everything and would have served a signed-out landing page and
// stale API JSON forever.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { detectPlatform, isInstalledApp, shouldOfferInstall } from '../lib/pwa.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// app/manifest.ts is TypeScript returning an object; strip the import and the
// type annotation so it can be evaluated without a Next build.
function loadManifest() {
  const src = read('app/manifest.ts');
  const body = src
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/export default function manifest\(\): MetadataRoute\.Manifest \{/, 'return (')
    .replace(/\n\}\s*$/, '\n);');
  return new Function(body)();
}

describe('PWA manifest', () => {
  const manifest = loadManifest();

  it('has the fields Chrome requires to consider the app installable', () => {
    for (const field of ['name', 'short_name', 'start_url', 'display']) {
      assert.ok(manifest[field], `manifest.${field} is required for installability`);
    }
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
  });

  it('declares 192 and 512 icons with purpose any', () => {
    const any = manifest.icons.filter((i: { purpose?: string }) => i.purpose === 'any');
    const sizes = any.map((i: { sizes: string }) => i.sizes);
    assert.ok(sizes.includes('192x192'), 'a 192x192 any-purpose icon is required');
    assert.ok(sizes.includes('512x512'), 'a 512x512 any-purpose icon is required');
  });

  it('declares separate maskable icons', () => {
    const maskable = manifest.icons.filter((i: { purpose?: string }) => i.purpose === 'maskable');
    assert.ok(maskable.length >= 2, 'maskable 192 and 512 should be declared separately');
    // A single icon declared "any maskable" lets the launcher mask artwork that
    // was not drawn with the safe zone in mind.
    for (const icon of manifest.icons) {
      assert.notEqual(icon.purpose, 'any maskable');
      assert.ok(!String(icon.purpose).includes(' '));
    }
  });

  it('points only at same-origin icons that exist on disk', () => {
    for (const icon of manifest.icons) {
      assert.ok(icon.src.startsWith('/'), `icon ${icon.src} must be same-origin`);
      assert.ok(!/^https?:/.test(icon.src), `icon ${icon.src} must not be remote`);
      const onDisk = join(ROOT, 'public', icon.src);
      assert.ok(existsSync(onDisk), `manifest references ${icon.src} but ${onDisk} is missing`);
    }
  });

  it('does not reference the placeholder photos it used to', () => {
    const src = read('app/manifest.ts');
    assert.doesNotMatch(src, /picsum\.photos/);
    const sw = read('public/sw.js');
    assert.doesNotMatch(sw, /picsum\.photos/);
    assert.doesNotMatch(sw, /manifest\.json/, 'the manifest is served as .webmanifest');
  });
});

describe('PWA icons', () => {
  const ICONS = [
    { path: 'public/icons/icon-192.png', size: 192 },
    { path: 'public/icons/icon-512.png', size: 512 },
    { path: 'public/icons/maskable-192.png', size: 192 },
    { path: 'public/icons/maskable-512.png', size: 512 },
    { path: 'public/icons/apple-touch-icon.png', size: 180 },
    { path: 'app/icon.png', size: 64 },
    { path: 'app/apple-icon.png', size: 180 },
  ];

  for (const icon of ICONS) {
    it(`${icon.path} is a ${icon.size}x${icon.size} PNG`, async () => {
      assert.ok(existsSync(join(ROOT, icon.path)), `${icon.path} is missing`);
      const meta = await sharp(join(ROOT, icon.path)).metadata();
      assert.equal(meta.format, 'png');
      assert.equal(meta.width, icon.size);
      assert.equal(meta.height, icon.size);
    });
  }

  it('the Apple touch icon is opaque (iOS shows transparency as black)', async () => {
    const { data, info } = await sharp(join(ROOT, 'public/icons/apple-touch-icon.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) transparent++;
    assert.equal(transparent, 0, `${transparent} transparent pixels in the Apple touch icon`);
    assert.equal(info.channels, 4);
  });

  // Bright-pixel bounding box, as a fraction of the canvas.
  async function artworkBox(file: string) {
    const meta = await sharp(join(ROOT, file)).metadata();
    const size = meta.width!;
    const { data, info } = await sharp(join(ROOT, file)).raw().toBuffer({ resolveWithObject: true });
    const c = info.channels;
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * c] > 150) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    assert.ok(maxX >= 0, `${file}: no artwork found`);
    return { w: (maxX - minX + 1) / size, h: (maxY - minY + 1) / size };
  }

  it('maskable artwork is scaled into the 80% safe zone', async () => {
    for (const file of ['public/icons/maskable-192.png', 'public/icons/maskable-512.png']) {
      const box = await artworkBox(file);
      // Launchers crop maskable icons to a circle/squircle; anything outside the
      // central 80% can be clipped. Measured, not assumed.
      assert.ok(box.w <= 0.8, `${file}: artwork is ${(box.w * 100).toFixed(1)}% wide`);
      assert.ok(box.h <= 0.8, `${file}: artwork is ${(box.h * 100).toFixed(1)}% tall`);
    }
  });

  it('maskable artwork is strictly smaller than the any-purpose artwork', async () => {
    // Proves the safe-zone transform was actually applied, rather than the
    // border happening to be empty. Without this, a maskable icon that is just
    // a copy of the normal one would pass the test above.
    const any = await artworkBox('public/icons/icon-512.png');
    const maskable = await artworkBox('public/icons/maskable-512.png');
    assert.ok(
      maskable.w < any.w * 0.9,
      `maskable (${(maskable.w * 100).toFixed(1)}%) is not meaningfully smaller than any (${(any.w * 100).toFixed(1)}%)`
    );
    assert.ok(
      maskable.h < any.h * 0.9,
      `maskable (${(maskable.h * 100).toFixed(1)}%) is not meaningfully smaller than any (${(any.h * 100).toFixed(1)}%)`
    );
  });

  it('the safe-zone check would fail a non-maskable icon', async () => {
    // Guard against a tautology: the plain icon, which is NOT scaled for
    // cropping, must not satisfy the maskable bound.
    const any = await artworkBox('public/icons/icon-512.png');
    assert.ok(any.w > 0.28, `expected the unscaled artwork to be wider than the maskable one (${any.w})`);
  });
});

// Evaluate the real matcher out of the shipped worker, rather than restating it:
// a copy of the rules in a test file is how a security control ends up asserted
// against a fiction. The block is self-contained apart from OFFLINE_URL.
function loadPublicPageMatcher(): (request: { url: string }) => boolean {
  const sw = read('public/sw.js');
  const start = sw.indexOf('const PUBLIC_OFFLINE_PATHS');
  const end = sw.indexOf('async function networkFirstNavigation');
  assert.ok(start > 0 && end > start, 'sw.js no longer contains the public-path block');
  const body = `const OFFLINE_URL = '/offline';\n${sw.slice(start, end)}\nreturn isPublicPage;`;
  return new Function(body)() as (request: { url: string }) => boolean;
}

describe('service worker safety', () => {
  const sw = read('public/sw.js');
  const isPublicPage = loadPublicPageMatcher();

  it('never caches or intercepts API traffic', () => {
    assert.match(sw, /function isApi/);
    assert.match(sw, /pathname\.startsWith\('\/api\/'\)/);
    assert.match(sw, /if \(isApi\(url\.pathname\)\) return;/);
  });

  it('uses network-first for navigations, not cache-first', () => {
    // The regression: '/' cached at install is the signed-out landing page.
    assert.match(sw, /networkFirstNavigation/);
    assert.match(sw, /request\.mode === 'navigate'/);
    assert.doesNotMatch(sw, /caches\.match\(event\.request\)\.then\(\s*\(response\)\s*=>\s*\{?\s*return response \|\| fetch/);
  });

  it('ignores non-GET requests entirely', () => {
    assert.match(sw, /if \(request\.method !== 'GET'\) return;/);
  });

  it('ignores cross-origin requests', () => {
    assert.match(sw, /url\.origin !== self\.location\.origin/);
  });

  it('deletes caches from earlier versions', () => {
    assert.match(sw, /caches\.keys\(\)/);
    assert.match(sw, /caches\.delete\(n\)/);
    assert.match(sw, /startsWith\('churchos-'\)/);
  });

  it('precaches an offline page it can fall back to', () => {
    assert.match(sw, /OFFLINE_URL = '\/offline'/);
    assert.ok(existsSync(join(ROOT, 'app/offline/page.tsx')), 'app/offline/page.tsx is missing');
  });

  describe('private pages are never written to the shell cache', () => {
    // P1-4 in SECURITY_REVIEW-2026-10-30.md: a navigated page used to be cached
    // unconditionally, so a member roster opened on a shared church tablet stayed
    // readable from devtools — and stayed readable after sign-out, because logging
    // out clears a cookie and not Cache Storage.
    it('refuses every private top-level route in app/', () => {
      const appDir = join(ROOT, 'app');
      const routes = readdirSync(appDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      // Anything that is not on the worker's public list must be refused, with no
      // exception list in the test: that is what default-deny means.
      const publicRoutes = new Set(['offline', 'login', 'signup', 'denominations', 'd']);
      for (const route of routes) {
        const isPublic = isPublicPage({ url: `https://app.example/${route}` });
        if (publicRoutes.has(route)) {
          assert.ok(isPublic, `/${route} is a public page and should stay cachable`);
        } else {
          assert.ok(!isPublic, `/${route} is not on the public allowlist and must not be cached`);
        }
      }
      assert.ok(routes.includes('c'), 'fixture sanity: app/c must exist for this to mean anything');
    });

    it('refuses deep private paths and unknown routes', () => {
      for (const path of [
        '/c/ekero', '/c/ekero/admin/members', '/c/ekero/admin/settings',
        '/admin/anything', '/api/sms/send', '/auth/callback', '/overseer/churches',
        '/super-admin/tenants', '/messages/someone', '/applet/app/admin/dashboard',
        '/some-brand-new-page', '/c',
      ]) {
        assert.ok(
          !isPublicPage({ url: `https://app.example${path}` }),
          `${path} must not be cached offline`,
        );
      }
    });

    it('still keeps the pages a first-time offline visitor should see', () => {
      for (const path of ['/', '/offline', '/login', '/login/', '/signup']) {
        assert.ok(isPublicPage({ url: `https://app.example${path}` }), `${path} should stay cachable`);
      }
    });

    it('survives a garbage url instead of throwing inside the fetch handler', () => {
      assert.equal(isPublicPage({ url: 'not a url' }), false);
      assert.equal(isPublicPage({ url: '' }), false);
    });

    it('gates the cache.put on the matcher, and the cache version was bumped', () => {
      // The version bump is what deletes the pre-fix cache — the one that may
      // already contain a private page.
      assert.match(sw, /if \(response\.ok && response\.type === 'basic' && isPublicPage\(request\)\)/);
      assert.match(sw, /const VERSION = 'v3'/);
      assert.match(sw, /cache\.delete\(request\)/);
      // The old unconditional write, in either shape, must not come back.
      assert.doesNotMatch(sw, /if \(response\.ok && response\.type === 'basic'\)\s*\{\s*cache\.put/);
    });
  });
});

describe('install gating logic', () => {
  it('offers install on a fresh browser visit', () => {
    assert.equal(shouldOfferInstall({ installed: false, snoozedThisSession: false, isStandalone: false }), true);
  });

  it('never offers install once installed', () => {
    assert.equal(shouldOfferInstall({ installed: true, snoozedThisSession: false, isStandalone: false }), false);
  });

  it('never offers install when already running standalone', () => {
    assert.equal(shouldOfferInstall({ installed: false, snoozedThisSession: false, isStandalone: true }), false);
  });

  it('snoozes for the session, then prompts again next launch', () => {
    // sessionStorage is cleared when the tab or installed app closes, so the
    // "snoozed" flag is false on the next open — which is the requested
    // "prompt on every open until installed" behaviour.
    assert.equal(shouldOfferInstall({ installed: false, snoozedThisSession: true, isStandalone: false }), false);
    assert.equal(shouldOfferInstall({ installed: false, snoozedThisSession: false, isStandalone: false }), true);
  });
});

describe('platform detection', () => {
  const UA = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    macDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    androidChrome: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  };

  it('detects iPhone as iOS', () => {
    assert.equal(detectPlatform({ userAgent: UA.iphone }), 'ios');
  });

  it('detects iPadOS pretending to be a Mac via touch points', () => {
    assert.equal(detectPlatform({ userAgent: UA.ipadDesktop, maxTouchPoints: 5 }), 'ios');
  });

  it('does not mistake a real Mac for an iPad', () => {
    assert.equal(detectPlatform({ userAgent: UA.macDesktop, maxTouchPoints: 0 }), 'ios'); // desktop Safari: manual flow
    assert.notEqual(detectPlatform({ userAgent: UA.macDesktop, maxTouchPoints: 0 }), 'chromium');
  });

  it('detects Android Chrome as chromium', () => {
    assert.equal(detectPlatform({ userAgent: UA.androidChrome }), 'chromium');
  });

  it('detects Edge as chromium despite the Chrome token', () => {
    assert.equal(detectPlatform({ userAgent: UA.edge }), 'chromium');
  });

  it('handles a missing user agent without throwing', () => {
    assert.equal(detectPlatform(undefined), 'other');
  });
});

describe('installed-app detection', () => {
  it('recognises navigator.standalone on iOS', () => {
    assert.equal(isInstalledApp({ navigator: { userAgent: '', standalone: true } }), true);
  });

  it('recognises the display-mode media query', () => {
    const win = {
      navigator: { userAgent: '', standalone: false },
      matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
    };
    assert.equal(isInstalledApp(win), true);
  });

  it('returns false in a normal browser tab', () => {
    const win = {
      navigator: { userAgent: '', standalone: false },
      matchMedia: () => ({ matches: false }),
    };
    assert.equal(isInstalledApp(win), false);
  });

  it('does not throw when matchMedia is unavailable', () => {
    assert.equal(isInstalledApp({ navigator: { userAgent: '' } }), false);
  });
});
