/**
 * Who is allowed to embed churchOs in an iframe.
 *
 * The reason this needs an explicit answer is the session cookie: it is
 * `SameSite=None` (proxy.ts, lib/supabase/*) precisely so an embedded workspace
 * keeps its cookies — and a cookie that is sent inside someone else's frame is a
 * clickjacking surface. A pastor signed in on the church tablet can be shown a
 * page that overlays our settings form and clicks Save for them. The origin guard
 * in proxy.ts does not help there: a click inside our own frame carries our own
 * `Origin`, so the request looks same-origin.
 *
 * `frame-ancestors` is the header that does help, and it is the one CSP directive
 * that needs no nonces, so it cannot break Next.js' inline bootstrap scripts —
 * which is why it is added on its own rather than as part of a full policy.
 *
 * Kept separate from next.config.ts so both the production and the development
 * answer can be asserted without rebuilding the config per process.
 */
export interface FrameAncestorInput {
  isProduction: boolean;
  /** Hosts the app already trusts for Server Action origins: APP_URL, Vercel, previews. */
  appHosts: readonly string[];
  /** Raw EMBED_HOSTS value: space- or comma-separated origins or bare hosts. */
  embedHostsRaw: string | undefined | null;
  /**
   * Set only from `EMBED_HOSTS=*`. Wildcards are not inferred from anything else:
   * an empty allowlist must never widen to the whole internet by accident.
   */
  allowAnyHost?: boolean;
}

/**
 * Normalise a configured entry into an origin usable in a CSP source list.
 * `https://partner.example/`, `partner.example` and `partner.example` all mean the
 * same thing. Anything that is not a usable http(s) origin is dropped rather than
 * passed through: `EMBED_HOSTS=*` typed into the wrong box must not become the
 * literal source `https://*`, and a malformed entry in a CSP list makes the whole
 * header invalid — which would silently remove the protection for everyone.
 */
export function normaliseEmbedOrigin(entry: string): string | null {
  const trimmed = entry.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, '') : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!url.hostname || url.hostname === '*' || url.hostname === '') return null;
    return candidate;
  } catch {
    return null;
  }
}

export function parseEmbedHosts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const origin = normaliseEmbedOrigin(part);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The value for `Content-Security-Policy: frame-ancestors`, or null when no header
 * should be sent.
 *
 * Development and previews get `null` on purpose: the app is routinely embedded by
 * tooling while it is being worked on (Arena's live preview, the Vercel preview
 * viewer), and a page that refuses to frame there reads as a broken build.
 */
export function resolveFrameAncestors(input: FrameAncestorInput): string | null {
  if (!input.isProduction) return null;
  if (input.allowAnyHost) return '*';
  const ancestors = new Set<string>(["'self'"]);
  // normaliseEmbedOrigin adds the https scheme for a bare host, which is the right
  // answer here: this branch only runs in production, where every app host is https.
  for (const host of input.appHosts) {
    const origin = normaliseEmbedOrigin(host);
    if (origin) ancestors.add(origin);
  }
  for (const origin of parseEmbedHosts(input.embedHostsRaw)) ancestors.add(origin);
  return [...ancestors].join(' ');
}
