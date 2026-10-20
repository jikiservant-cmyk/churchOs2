/**
 * tests/e2e/run.ts
 *
 * Full end-to-end suite for the churchOs sign-in / sign-up / activation flows.
 *
 * Stack (all real, all local):
 *   - embedded-postgres            real PostgreSQL 18, fresh data dir
 *   - supabase-schema.sql + migrations 005,006,007,009,010,008  (fresh-DB order)
 *   - MockSupabase (tests/e2e/mock-supabase.ts)
 *       GoTrue  (/auth/v1/*)  with real HS256 JWTs
 *       PostgREST (/rest/v1/*) executing REAL SQL as the JWT role —
 *       RLS policies are enforced exactly as they would be on Supabase
 *   - MockNajikiServer (tests/helpers/mock-najiki-server.ts)
 *       the Na'jiki partner API (Zod-validated) + we sign webhooks ourselves
 *   - `next dev`                   the actual application under test
 *
 * Every scenario goes over HTTP against the Next.js server: server actions
 * (signup/login/provision) are posted as the browser would (React 19 form
 * actions with the $ACTION_* hidden fields), API routes with fetch + cookies.
 *
 * Run:  npm run test:e2e        (or: node tests/e2e/run.ts)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { MockSupabase, initDatabase } from './mock-supabase.ts'
import { MockNajikiServer } from '../helpers/mock-najiki-server.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Small HTTP client with a cookie jar
// ─────────────────────────────────────────────────────────────────────────────

class CookieJar {
  private cookies = new Map<string, string>()

  ingest(headers: Headers) {
    const setCookie = headers.getSetCookie?.() || []
    for (const line of setCookie) {
      const [pair] = line.split(';')
      const idx = pair.indexOf('=')
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }

  header(): string | null {
    if (this.cookies.size === 0) return null
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  clear() {
    this.cookies.clear()
  }
}

interface HttpResponse {
  status: number
  headers: Headers
  text: string
  finalUrl: string
}

class E2EClient {
  jar = new CookieJar()
  base: string
  constructor(base: string) {
    this.base = base
  }

  async do(method: string, path: string, init: RequestInit, follow: number = 5): Promise<HttpResponse> {
    const headers = new Headers(init.headers)
    const cookie = this.jar.header()
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)

    const res = await fetch(`${this.base}${path}`, { ...init, headers, redirect: 'manual' })
    this.jar.ingest(res.headers)
    const text = await res.text()

    if (res.status >= 300 && res.status < 400 && follow > 0) {
      const location = res.headers.get('location')
      if (location) {
        const next = new URL(location, this.base)
        const res2 = await this.do('GET', `${next.pathname}${next.search}`, {}, follow - 1)
        return { ...res2, status: res2.status, text: res2.text }
      }
    }
    return { status: res.status, headers: res.headers, text, finalUrl: `${this.base}${path}` }
  }

  get(path: string): Promise<HttpResponse> {
    return this.do('GET', path, { headers: { accept: 'text/html' } })
  }

  postJson(path: string, body: unknown, extra?: Record<string, string>): Promise<HttpResponse> {
    return this.do('POST', path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    })
  }

  /** Sign + send a Na'jiki webhook exactly the way Na'jiki sends them. */
  async postNajikiWebhook(path: string, body: unknown, secret: string, sign = true): Promise<HttpResponse> {
    const raw = JSON.stringify(body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-najiki-notification': 'true' }
    if (sign) {
      const ts = Date.now()
      const v = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')
      headers['x-najiki-timestamp'] = String(ts)
      headers['x-najiki-signature'] = `t=${ts},v=${v}`
    }
    return this.do('POST', path, { method: 'POST', headers, body: raw })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// React 19 server-action form POST helper
// ─────────────────────────────────────────────────────────────────────────────

interface ActionState {
  error?: string
  success?: boolean
  redirectTo?: string
  notice?: string
  tenantId?: string
  slug?: string
}

function htmlDecode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Extract the action result state from the re-rendered page.
 *
 * useActionState re-renders the form with the NEW state serialised into the
 * `$ACTION_<ref>:1` hidden input (the next bound argument), e.g.
 *   value="[{"success":true,"redirectTo":"/signup/provision"}]"
 * That is the authoritative source — scanning the whole document for
 * "success": true hits flight-manifest noise (error boundaries, $undefined
 * tokens) and is only used as a fallback.
 */
function parseActionState(html: string): ActionState {
  // Extract the attribute from the RAW html first (the value is still
  // &quot;-escaped, so [^"]* captures the whole thing), then decode it.
  // Decoding the whole document first would turn the inner &quot; into real
  // quotes and truncate the capture at the first inner quote.
  const m = html.match(/name="\$ACTION_\d+:1" value="([^"]*)"/)
  if (m) {
    try {
      const parsed = JSON.parse(htmlDecode(m[1]))
      const st = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
      if (st && typeof st === 'object') {
        const rec = st as Record<string, unknown>
        return {
          error: typeof rec.error === 'string' ? rec.error : undefined,
          success: typeof rec.success === 'boolean' ? rec.success : undefined,
          redirectTo: typeof rec.redirectTo === 'string' ? rec.redirectTo : undefined,
          notice: typeof rec.notice === 'string' ? rec.notice : undefined,
          tenantId: typeof rec.tenantId === 'string' ? rec.tenantId : undefined,
          slug: typeof rec.slug === 'string' ? rec.slug : undefined,
        }
      }
    } catch {
      /* fall through to regex fallback */
    }
  }

  const decoded = htmlDecode(html)
  const out: ActionState = {}
  const lastStr = (key: string): string | undefined => {
    const re = new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"((?:[^"\\\\]|\\\\.)*?)\\\\?"`, 'g')
    let last: string | undefined
    let mm: RegExpExecArray | null
    while ((mm = re.exec(decoded)) !== null) last = mm[1]
    if (last === undefined || last.startsWith('$')) return undefined // flight tokens, not values
    return last.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const lastBool = (key: string): boolean | undefined => {
    const re = new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*(true|false)`, 'g')
    let last: boolean | undefined
    let mm: RegExpExecArray | null
    while ((mm = re.exec(decoded)) !== null) last = mm[1] === 'true'
    return last
  }
  out.error = lastStr('error')
  out.redirectTo = lastStr('redirectTo')
  out.notice = lastStr('notice')
  out.tenantId = lastStr('tenantId')
  out.slug = lastStr('slug')
  out.success = lastBool('success')
  return out
}

function parseActionManifest(html: string): { fields: Record<string, string>; actionId?: string } {
  const refIds: string[] = []
  const refRe = /name="\$ACTION_REF_(\d+)"/g
  let m: RegExpExecArray | null
  while ((m = refRe.exec(html)) !== null) refIds.push(m[1])

  const fields: Record<string, string> = {}
  for (const ref of refIds) {
    // The browser sends the (empty) $ACTION_REF_<n> marker field too — Next
    // needs it to associate the POST with the action.
    fields[`$ACTION_REF_${ref}`] = ''
    // Every $ACTION_<ref>:<n> argument field matters: for useActionState
    // forms the initial state rides in `$ACTION_1:1` and React's
    // decodeBoundActionMetaData fails the whole request when it is missing.
    for (const argM of html.matchAll(new RegExp(`name="\\$ACTION_${ref}:(\\d+)" value="([^"]*)"` , 'g'))) {
      fields[`$ACTION_${ref}:${argM[1]}`] = htmlDecode(argM[2])
    }
  }
  const keyMatch = /name="\$ACTION_KEY" value="([^"]*)"/.exec(html)
  if (keyMatch) fields['$ACTION_KEY'] = keyMatch[1]

  const actionId = fields[`$ACTION_${refIds[0]}:0`]?.match(/"id":"([a-f0-9]{40,64})"/)?.[1]
  return { fields, actionId }
}

async function actionPost(
  client: E2EClient,
  page: string,
  fields: Record<string, string>
): Promise<{ res: HttpResponse; state: ActionState }> {
  // Dev mode can rebuild the server-action manifest between the GET that
  // rendered the form and the POST (first-compile churn), which surfaces as
  // "Failed to find Server Action". Re-fetch the form and retry in that case.
  let last: { res: HttpResponse; state: ActionState } | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const pageRes = await client.get(page)
    const html = pageRes.text
    const manifest = parseActionManifest(html)
    if (!manifest.actionId) throw new Error(`Could not find server action id on ${page}\nHTML head: ${html.slice(0, 400)}`)

    const actionFields = manifest.fields

    // multipart/form-data, like the browser sends it
    const boundary = `----e2eboundary${randomBytes(8).toString('hex')}`
    const parts: string[] = []
    for (const [k, v] of Object.entries({ ...fields, ...actionFields })) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
      )
    }
    parts.push(`--${boundary}--\r\n`)
    const body = parts.join('')

    const res = await client.do('POST', page, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        accept: 'text/html',
      },
      body,
    })
    last = { res, state: parseActionState(res.text) }
    if (process.env.E2E_LOG_ATTEMPTS) {
      appendFileSync(
        '/tmp/e2e-attempts.log',
        `--- ${page} attempt ${attempt + 1}: status=${res.status} state=${JSON.stringify(parseActionState(res.text))}\nbody head: ${res.text.slice(0, 300).replace(/\n/g, ' ')}\n`
      )
    }

    if (res.status === 500 && res.text.includes('Failed to find Server Action')) {
      continue // manifest churn — retry with a freshly rendered form
    }
    return last
  }
  throw new Error(`action POST to ${page} kept failing: ${last?.res.status} ${last?.state.error ?? ''}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario harness
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string
  passed: boolean
  ms: number
  error?: string
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([fn(), timeout])
  } finally {
    clearTimeout(timer!)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The E2E run
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function freePortSync(): number {
  // Ports are unlikely to collide; bound to 127.0.0.1.
  return 54000 + Math.floor(Math.random() * 1900)
}

export interface E2EReport {
  results: ScenarioResult[]
  durationMs: number
}

export async function runE2E(): Promise<E2EReport> {
  const started = Date.now()
  const results: ScenarioResult[] = []

  const pgPort = freePortSync()
  const supaPort = freePortSync()
  const nextPort = freePortSync()
  const dbDir = mkdtempSync(join(tmpdir(), 'churchos-e2e-pg-'))

  const pgInstance = new EmbeddedPostgres({
    databaseDir: dbDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    authMethod: 'scram-sha-256',
    persistent: false,
  })

  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
  })
  pool.on('error', () => {
    /* idle-client errors are handled per-query; don't crash the harness */
  })

  const jwtSecret = `e2e-jwt-secret-${randomBytes(16).toString('hex')}`
  const anonKey = `e2e-anon-key-${randomBytes(12).toString('hex')}`
  const serviceKey = `e2e-service-key-${randomBytes(12).toString('hex')}`

  const mockSupa = new MockSupabase({ jwtSecret, anonKey, serviceRoleKey: serviceKey, port: supaPort, pool })
  const mockNajiki = new MockNajikiServer()

  let nextProc: ChildProcess | null = null
  const nextLog: string[] = [] // function scope so the teardown finally can dump it
  const prevEnvLocal = join(REPO_ROOT, '.env.local')
  const hadEnvLocal = existsSync(prevEnvLocal)
  const prevEnvLocalContent = hadEnvLocal ? readFileSync(prevEnvLocal, 'utf8') : null

  // IDs set up during seeding
  const ids = {
    denomId: '',
    overseerId: '',
    pastor1: '',
    church1: '',
    church1Slug: 'e2e-grace-chapel',
    pastor2: '',
    church2: '',
    church2Slug: 'e2e-hope-church',
    inviteGood: 'E2E-INV-GOOD',
    inviteExhausted: 'E2E-INV-MAX',
    inviteRevoked: 'E2E-INV-REV',
    merchantRef: '',
    providerTxId: '',
  }

  const scenario = (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now()
    return Promise.resolve()
      .then(fn)
      .then(() => results.push({ name, passed: true, ms: Date.now() - t0 }))
      .catch((err) => results.push({ name, passed: false, ms: Date.now() - t0, error: String(err?.stack || err) }))
      .then(() => {
        const r = results[results.length - 1]
        console.log(`${r.passed ? '  PASS' : '  FAIL'}  ${name}  (${r.ms}ms)`)
        if (!r.passed) console.log(String(r.error).split('\n').slice(0, 12).join('\n'))
      })
  }

  try {
    // ── 1. Real PostgreSQL with the real schema ────────────────────────────
    console.log(`[e2e] starting embedded postgres on 127.0.0.1:${pgPort} (data: ${dbDir})`)
    await pgInstance.initialise()
    await pgInstance.start()

    console.log('[e2e] applying supabase-schema.sql + migrations (fresh-DB order: 005,006,007,009,010,008)')
    const readMig = (n: string) => readFileSync(join(REPO_ROOT, 'migrations', n), 'utf8')
    await initDatabase(
      pool,
      readFileSync(join(REPO_ROOT, 'supabase-schema.sql'), 'utf8'),
      [
        { name: '005_consecutive_event_flags.sql', sql: readMig('005_consecutive_event_flags.sql') },
        { name: '006_expected_days_and_auto_close.sql', sql: readMig('006_expected_days_and_auto_close.sql') },
        { name: '007_tenant_scoped_codes.sql', sql: readMig('007_tenant_scoped_codes.sql') },
        { name: '009_church_activation.sql', sql: readMig('009_church_activation.sql') },
        { name: '010_denomination_support.sql', sql: readMig('010_denomination_support.sql') },
        { name: '008_atomic_church_activation.sql', sql: readMig('008_atomic_church_activation.sql') },
      ]
    )
    console.log('[e2e] database ready')

    // ── 2. Mocks ───────────────────────────────────────────────────────────
    await mockSupa.start()
    const najikiUrl = await mockNajiki.start()
    console.log(`[e2e] mock supabase on :${supaPort}, mock najiki on ${najikiUrl}`)

    // ── 3. Next.js dev server ──────────────────────────────────────────────
    writeFileSync(
      prevEnvLocal,
      [
        `NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${supaPort}"`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonKey}"`,
        `SUPABASE_SERVICE_ROLE_KEY="${serviceKey}"`,
        `NAJIKI_API_URL="${najikiUrl}"`,
        `NAJIKI_API_KEY="${mockNajiki.apiKey}"`,
        `NAJIKI_WEBHOOK_SECRET="${mockNajiki.webhookSecret}"`,
        `NAJIKI_APPLICATION_CODE="church"`,
        `USHER_JWT_SECRET="e2e-ushertestsecret-e2e-ushertestsecret"`,
        '',
      ].join('\n')
    )

    console.log(`[e2e] starting next dev on :${nextPort}`)
    nextProc = spawn('npx', ['next', 'dev', '-p', String(nextPort), '-H', '0.0.0.0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${supaPort}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        NAJIKI_API_URL: najikiUrl,
        NAJIKI_API_KEY: mockNajiki.apiKey,
        NAJIKI_WEBHOOK_SECRET: mockNajiki.webhookSecret,
        NAJIKI_APPLICATION_CODE: 'church',
        USHER_JWT_SECRET: 'e2e-ushertestsecret-e2e-ushertestsecret',
      },
    })
    nextProc.stdout!.on('data', (d) => nextLog.push(String(d)))
    nextProc.stderr!.on('data', (d) => nextLog.push(String(d)))

    await withTimeout(
      async () => {
        // Wait until the server answers (and tolerate the first compile).
        for (let i = 0; i < 240; i++) {
          try {
            const r = await fetch(`http://127.0.0.1:${nextPort}/login`)
            if (r.status < 500) return
          } catch {
            /* not up yet */
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        throw new Error(`next dev never became ready:\n${nextLog.join('').slice(-3000)}`)
      },
      180_000,
      'next dev startup'
    )
    console.log('[e2e] next dev ready')

    // Warm the pages so first-compile churn (which regenerates the
    // server-action manifest in dev) happens before any scenario runs.
    {
      const warm = new E2EClient(`http://127.0.0.1:${nextPort}`)
      for (const p of ['/signup', '/signup/provision', '/login', '/overseer']) {
        await warm.get(p).catch(() => undefined)
      }
    }

    const client = new E2EClient(`http://127.0.0.1:${nextPort}`)

    // ═══════════════════════════════════════════════════════════════════════
    // SEED: denomination, overseer, invite codes (direct SQL, like an admin)
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('seed: denomination + overseer + invites', async () => {
      ids.overseerId = await mockSupa.seedUser('overseer@e2e.test', 'OverseerPass1!')
      const denom = await pool.query(
        `INSERT INTO church.denominations (slug, name, is_listed, tagline)
         VALUES ('e2e-faith-union', 'E2E Faith Union', true, 'End to end')
         RETURNING id`
      )
      ids.denomId = denom.rows[0].id as string

      await pool.query(
        `INSERT INTO public.admin_profiles (id, email, role, app_type)
         VALUES ($1, 'overseer@e2e.test', 'overseer', 'church')`,
        [ids.overseerId]
      )
      await pool.query(
        `INSERT INTO church.denominations_admins (denomination_id, user_id) VALUES ($1, $2)`,
        [ids.denomId, ids.overseerId]
      )

      await pool.query(
        `INSERT INTO church.denomination_invites (denomination_id, code, max_uses, uses_count, expires_at, created_by)
         VALUES ($1, $2, 2, 0, now() + interval '30 days', $3)`,
        [ids.denomId, ids.inviteGood, ids.overseerId]
      )
      await pool.query(
        `INSERT INTO church.denomination_invites (denomination_id, code, max_uses, uses_count, expires_at, created_by)
         VALUES ($1, $2, 1, 1, now() + interval '30 days', $3)`,
        [ids.denomId, ids.inviteExhausted, ids.overseerId]
      )
      await pool.query(
        `INSERT INTO church.denomination_invites (denomination_id, code, max_uses, uses_count, revoked, created_by)
         VALUES ($1, $2, 5, 0, true, $3)`,
        [ids.denomId, ids.inviteRevoked, ids.overseerId]
      )
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S1. SIGNUP (new pastor) — action over HTTP, session cookie issued
    // ═══════════════════════════════════════════════════════════════════════
    const pastor1 = new E2EClient(`http://127.0.0.1:${nextPort}`)
    await scenario('signup: new pastor account (action POST)', async () => {
      const { state } = await actionPost(pastor1, '/signup', {
        email: 'pastor1@e2e.test',
        password: 'PastorPass1!',
      })
      assert.equal(state.success, true, `expected signup success, got: ${JSON.stringify(state)}`)
      assert.equal(state.redirectTo, '/signup/provision')
      assert.ok(!state.error, `unexpected error: ${state.error}`)
      // A session cookie must now exist (mock GoTrue issued a real JWT).
      assert.ok(pastor1.jar.header()?.includes('sb-'), 'no supabase session cookie after signup')
      ids.pastor1 = (await pool.query(
        `SELECT id FROM auth.users WHERE email = 'pastor1@e2e.test'`
      )).rows[0].id as string
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S2. PROVISION with a valid denomination invite
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('provision: church + invite code links denomination', async () => {
      const prov = await actionPost(pastor1, '/signup/provision', {
        name: 'E2E Grace Chapel',
        slug: ids.church1Slug,
        invite_code: ids.inviteGood,
      })
      const state = prov.state
      assert.ok(!state.error, `provision error: ${state.error}`)
      assert.equal(state.success, true)
      assert.equal(state.slug, ids.church1Slug)

      const church = (
        await pool.query(`SELECT * FROM church.churches WHERE slug = $1`, [ids.church1Slug])
      ).rows[0]
      assert.ok(church, 'church row not created')
      ids.church1 = church.id as string
      assert.equal(church.activation_status, 'pending_payment', 'new church must start pending_payment')
      assert.equal(church.denomination_id, ids.denomId, 'invite must link the denomination')

      const profile = (
        await pool.query(`SELECT * FROM public.admin_profiles WHERE id = $1`, [ids.pastor1])
      ).rows[0]
      assert.equal(profile.role, 'pastor')
      assert.equal(profile.tenant_id, ids.church1, 'profile must be linked to the new church')

      const invite = (
        await pool.query(`SELECT uses_count FROM church.denomination_invites WHERE code = $1`, [
          ids.inviteGood,
        ])
      ).rows[0]
      assert.equal(invite.uses_count, 1, 'invite usage must be incremented')
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S3. ACTIVATION GATE: pending church cannot open the dashboard
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('gate: pending church is redirected to activation page', async () => {
      const res = await pastor1.get(`/${ids.church1Slug}/admin`)
      // The layout redirects; follow until we land on the activation page.
      assert.ok(
        res.text.includes('Activation') || res.status === 200,
        `unexpected body for /${ids.church1Slug}/admin`
      )
      const activationPage = await pastor1.get(`/${ids.church1Slug}/admin/activation`)
      assert.equal(activationPage.status, 200)

      const api = await pastor1.get('/api/church/activation/status')
      assert.equal(api.status, 200)
      const status = JSON.parse(api.text)
      assert.equal(status.activationStatus, 'pending_payment')
      assert.equal(status.isActive, false)
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S4. LOGIN action → server-derived redirect to own church
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('login: action POST routes pastor to own church', async () => {
      const fresh = new E2EClient(`http://127.0.0.1:${nextPort}`)
      const { res } = await actionPost(fresh, '/login', {
        email: 'pastor1@e2e.test',
        password: 'PastorPass1!',
      })
      // On success the action stores the session and the /login server page
      // re-renders as already-authenticated and redirects — the pastor must
      // land inside their own church admin area (the re-rendered login page
      // embeds no action state because it no longer renders the form). The
      // church is still pending_payment here, so the middleware may deepen
      // the URL to /admin/activation.
      assert.ok(
        res.finalUrl.includes(`/${ids.church1Slug}/admin`),
        `login must route into /${ids.church1Slug}/admin, got ${res.finalUrl}`
      )
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S5. START ACTIVATION PAYMENT → real Na'jiki contract over HTTP
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('activation: start payment (Na\'jiki contract)', async () => {
      const res = await pastor1.postJson('/api/church/activation/start', {
        phoneNumber: '0772 123 456',
        provider: 'najiki',
      })
      assert.equal(res.status, 200, `start: ${res.text}`)
      const body = JSON.parse(res.text)
      assert.equal(body.success, true, JSON.stringify(body))
      assert.match(body.merchantReference, /^ACT-/, 'merchant reference format')
      ids.merchantRef = body.merchantReference
      ids.providerTxId = body.providerTransactionId || ''

      // Exactly ONE payment hit the gateway, with the exact contract.
      assert.equal(mockNajiki.payments.length, 1, 'expected exactly one gateway payment')
      const p = mockNajiki.payments[0]
      assert.equal(p.body.applicationCode, 'church')
      assert.equal(p.body.amount, 17000)
      assert.equal(p.body.currency, 'UGX')
      assert.equal(p.body.phoneNumber, '256772123456', 'phone must be normalised to E.164 digits')
      assert.equal(p.body.externalEntityId, ids.church1)
      assert.equal(p.body.idempotencyKey, ids.merchantRef)
      assert.equal(p.body.metadata.churchId, ids.church1)
      assert.equal(p.body.metadata.merchantReference, ids.merchantRef)
      assert.equal(p.body.metadata.type, 'church_activation')

      // Ledger row is pending; church still pending_payment.
      const row = (
        await pool.query(`SELECT * FROM church.activation_payments WHERE merchant_reference = $1`, [
          ids.merchantRef,
        ])
      ).rows[0]
      assert.equal(row.status, 'pending')
      assert.equal(row.initiated_by, ids.pastor1)
      const church = (await pool.query(`SELECT activation_status FROM church.churches WHERE id = $1`, [ids.church1])).rows[0]
      assert.equal(church.activation_status, 'pending_payment')
    })

    await scenario('activation: double-click reuses the pending attempt', async () => {
      const res = await pastor1.postJson('/api/church/activation/start', { phoneNumber: '0772123456' })
      assert.equal(res.status, 200)
      const body = JSON.parse(res.text)
      assert.equal(body.success, true)
      assert.equal(body.reusedExistingPending, true, JSON.stringify(body))
      assert.equal(body.merchantReference, ids.merchantRef, 'must reuse the same reference')
      assert.equal(mockNajiki.payments.length, 1, 'no second gateway push allowed')
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S6. WEBHOOK SECURITY
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('webhook: unsigned request is rejected (401)', async () => {
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        { reference: ids.merchantRef, amount: 17000, currency: 'UGX', status: 'success' },
        mockNajiki.webhookSecret,
        false
      )
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.text}`)
      const church = (await pool.query(`SELECT activation_status FROM church.churches WHERE id = $1`, [ids.church1])).rows[0]
      assert.equal(church.activation_status, 'pending_payment', 'unsigned webhook must not activate')
    })

    await scenario('webhook: forged signature is rejected (401)', async () => {
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        { reference: ids.merchantRef, amount: 17000, currency: 'UGX', status: 'success' },
        'totally-wrong-secret',
        true
      )
      assert.equal(res.status, 401, `expected 401, got ${res.status}`)
    })

    await scenario('webhook: underpaid amount does not activate', async () => {
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        { reference: ids.merchantRef, amount: 9999, currency: 'UGX', status: 'success' },
        mockNajiki.webhookSecret
      )
      assert.equal(res.status, 422, `expected 422, got ${res.status}: ${res.text}`)
      const church = (await pool.query(`SELECT activation_status FROM church.churches WHERE id = $1`, [ids.church1])).rows[0]
      assert.equal(church.activation_status, 'pending_payment', 'underpaid webhook must not activate')
      const row = (
        await pool.query(`SELECT status FROM church.activation_payments WHERE merchant_reference = $1`, [
          ids.merchantRef,
        ])
      ).rows[0]
      assert.equal(row.status, 'pending', 'underpaid webhook must leave the ledger row pending')
    })

    await scenario('webhook: blank provider status does not activate', async () => {
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        { reference: ids.merchantRef, amount: 17000, currency: 'UGX', status: '' },
        mockNajiki.webhookSecret
      )
      assert.equal(res.status, 422, `expected 422, got ${res.status}: ${res.text}`)
      const church = (await pool.query(`SELECT activation_status FROM church.churches WHERE id = $1`, [ids.church1])).rows[0]
      assert.equal(church.activation_status, 'pending_payment')
    })

    await scenario('webhook: wrong provider does not activate', async () => {
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        { reference: ids.merchantRef, amount: 17000, currency: 'UGX', status: 'success', provider: 'mtn-momo' },
        mockNajiki.webhookSecret
      )
      assert.equal(res.status, 422, `expected 422, got ${res.status}: ${res.text}`)
      const church = (await pool.query(`SELECT activation_status FROM church.churches WHERE id = $1`, [ids.church1])).rows[0]
      assert.equal(church.activation_status, 'pending_payment')
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S7. THE GOOD WEBHOOK: activation actually happens
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('webhook: signed success activates the church', async () => {
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        {
          reference: ids.merchantRef,
          id: ids.providerTxId || 'pay_e2e',
          amount: 17000,
          currency: 'UGX',
          status: 'success',
          metadata: { churchId: ids.church1, merchantReference: ids.merchantRef, type: 'church_activation' },
        },
        mockNajiki.webhookSecret
      )
      assert.equal(res.status, 200, `webhook: ${res.text}`)
      const body = JSON.parse(res.text)
      assert.equal(body.status, 'ok')
      assert.equal(body.churchId, ids.church1)

      const church = (
        await pool.query(`SELECT activation_status, activation_paid_at FROM church.churches WHERE id = $1`, [
          ids.church1,
        ])
      ).rows[0]
      assert.equal(church.activation_status, 'active')
      assert.ok(church.activation_paid_at, 'activation_paid_at must be stamped')

      const row = (
        await pool.query(`SELECT status, verified_at FROM church.activation_payments WHERE merchant_reference = $1`, [
          ids.merchantRef,
        ])
      ).rows[0]
      assert.equal(row.status, 'paid')
      assert.ok(row.verified_at)

      // Event was recorded by the atomic RPC (linked via merchant_reference).
      const evt = (
        await pool.query(`SELECT count(*)::int AS n FROM church.payment_events WHERE merchant_reference = $1`, [
          ids.merchantRef,
        ])
      ).rows[0]
      assert.ok(evt.n >= 1, 'activation must write a payment event')
    })

    await scenario('webhook: replay of the same success is idempotent', async () => {
      // Snapshot the committed state so we can prove the replay is a no-op.
      const before = (
        await pool.query(
          `SELECT c.activation_status, c.activation_paid_at, p.status AS pay_status, p.verified_at
             FROM church.churches c
             JOIN church.activation_payments p ON p.merchant_reference = $1
            WHERE c.id = p.church_id`,
          [ids.merchantRef]
        )
      ).rows[0]

      // A real Na'jiki retry resends the SAME notification, including the
      // provider transaction id the payment was confirmed with.
      const res = await pastor1.postNajikiWebhook(
        '/api/church/activation/webhook',
        {
          reference: ids.merchantRef,
          id: ids.providerTxId || 'pay_e2e',
          amount: 17000,
          currency: 'UGX',
          status: 'success',
          metadata: { churchId: ids.church1, merchantReference: ids.merchantRef, type: 'church_activation' },
        },
        mockNajiki.webhookSecret
      )
      assert.equal(res.status, 200, `replay must be accepted: ${res.text}`)

      const after = (
        await pool.query(
          `SELECT c.activation_status, c.activation_paid_at, p.status AS pay_status, p.verified_at
             FROM church.churches c
             JOIN church.activation_payments p ON p.merchant_reference = $1
            WHERE c.id = p.church_id`,
          [ids.merchantRef]
        )
      ).rows[0]
      // Idempotent: the replay re-processes nothing.
      assert.equal(after.activation_status, before.activation_status, 'church status must not change on replay')
      assert.equal(String(after.activation_paid_at), String(before.activation_paid_at), 'activation_paid_at must not change on replay')
      assert.equal(after.pay_status, 'paid', 'payment must remain paid')
      assert.equal(String(after.verified_at), String(before.verified_at), 'verified_at must not change on replay')

      // The replay is audited as an ignored duplicate, not a new activation.
      const lastEvent = (
        await pool.query(
          `SELECT outcome FROM church.payment_events WHERE merchant_reference = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [ids.merchantRef]
        )
      ).rows[0]
      assert.ok(lastEvent, 'replay must write an audit event')
      assert.match(lastEvent.outcome, /duplicate|ignored/i, `replay should be audited as a duplicate, got '${lastEvent.outcome}'`)
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S8. DASHBOARD UNLOCKED
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('dashboard: active church opens the admin area', async () => {
      const res = await pastor1.get(`/${ids.church1Slug}/admin`)
      assert.equal(res.status, 200)
      assert.ok(
        !res.text.includes('Complete Activation') && !res.text.includes('Activate your workspace'),
        'active church must not see the activation interstitial'
      )
      const status = await pastor1.get('/api/church/activation/status')
      assert.equal(JSON.parse(status.text).isActive, true)
    })

    await scenario('health: /api/health reports ok for uptime monitors (anon)', async () => {
      const anon = new E2EClient(`http://127.0.0.1:${nextPort}`)
      const res = await anon.get('/api/health')
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`)
      const body = JSON.parse(res.text)
      assert.equal(body.status, 'ok')
      assert.equal(body.db, 'ok')
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S9. OVERSEER FLOW
    // ═══════════════════════════════════════════════════════════════════════
    const overseer = new E2EClient(`http://127.0.0.1:${nextPort}`)
    await scenario('overseer: login routes to the overseer area', async () => {
      const { res } = await actionPost(overseer, '/login', {
        email: 'overseer@e2e.test',
        password: 'OverseerPass1!',
      })
      // The /login server page redirects an authenticated overseer to their
      // denomination area; verify the final landing URL.
      assert.ok(
        res.finalUrl.endsWith('/overseer') || res.finalUrl.endsWith('/d/e2e-faith-union/overseer'),
        `unexpected overseer redirect: ${res.finalUrl}`
      )
    })

    await scenario('overseer: /overseer renders with denomination data', async () => {
      const res = await overseer.get('/overseer')
      assert.equal(res.status, 200)
      assert.ok(res.text.includes('E2E Faith Union'), 'denomination name must be visible')
      assert.ok(res.text.includes('E2E Grace Chapel') || res.text.includes('e2e-grace-chapel'), 'member church must be visible')
    })

    await scenario('pastor: /overseer is denied (fail-closed gate)', async () => {
      const res = await pastor1.get('/overseer')
      const landedOnOverseer = res.status === 200 && res.text.includes('E2E Faith Union')
      assert.ok(!landedOnOverseer, 'a pastor must not see the overseer dashboard')
    })

    await scenario('anon: /overseer is not reachable without a session', async () => {
      const anon = new E2EClient(`http://127.0.0.1:${nextPort}`)
      const res = await anon.get('/overseer')
      assert.ok(
        !(res.status === 200 && res.text.includes('E2E Faith Union')),
        'unauthenticated visitor must not see the overseer dashboard'
      )
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S10. CROSS-TENANT ISOLATION
    // ═══════════════════════════════════════════════════════════════════════
    const pastor2 = new E2EClient(`http://127.0.0.1:${nextPort}`)
    await scenario('second church: signup + provision without invite (independent)', async () => {
      await actionPost(pastor2, '/signup', { email: 'pastor2@e2e.test', password: 'PastorPass2!' })
      const { state } = await actionPost(pastor2, '/signup/provision', {
        name: 'E2E Hope Church',
        slug: ids.church2Slug,
        invite_code: '',
      })
      assert.ok(!state.error, `provision2: ${state.error}`)
      const church = (
        await pool.query(`SELECT * FROM church.churches WHERE slug = $1`, [ids.church2Slug])
      ).rows[0]
      assert.ok(church)
      ids.church2 = church.id as string
      assert.equal(church.denomination_id, null, 'no invite → independent church')
      assert.equal(church.activation_status, 'pending_payment')
    })

    await scenario('cross-tenant: pastor1 cannot open pastor2\'s church', async () => {
      const res = await pastor1.get(`/${ids.church2Slug}/admin`)
      // The layout must bounce them away from the foreign church.
      assert.ok(
        !(res.status === 200 && res.text.includes('E2E Hope Church') && res.text.includes('Members')),
        'pastor1 must not see pastor2\'s dashboard'
      )
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S11. INVITE CODE RULES
    // ═══════════════════════════════════════════════════════════════════════
    const pastor3 = new E2EClient(`http://127.0.0.1:${nextPort}`)
    await scenario('invite: unknown code is rejected with a clear error', async () => {
      await actionPost(pastor3, '/signup', { email: 'pastor3@e2e.test', password: 'PastorPass3!' })
      const { state } = await actionPost(pastor3, '/signup/provision', {
        name: 'E2E Third Church',
        slug: 'e2e-third-church',
        invite_code: 'E2E-NO-SUCH-CODE',
      })
      assert.ok(state.error && /not found/i.test(state.error), `expected 'not found', got: ${state.error}`)
      const rows = (await pool.query(`SELECT count(*)::int AS n FROM church.churches WHERE slug = 'e2e-third-church'`)).rows[0]
      assert.equal(rows.n, 0, 'no church may be created from a bad invite')
    })

    await scenario('invite: exhausted code is rejected', async () => {
      const { state } = await actionPost(pastor3, '/signup/provision', {
        name: 'E2E Third Church',
        slug: 'e2e-third-church',
        invite_code: ids.inviteExhausted,
      })
      assert.ok(state.error && /usage limit/i.test(state.error), `expected usage limit error, got: ${state.error}`)
    })

    await scenario('invite: revoked code is rejected', async () => {
      const { state } = await actionPost(pastor3, '/signup/provision', {
        name: 'E2E Third Church',
        slug: 'e2e-third-church',
        invite_code: ids.inviteRevoked,
      })
      assert.ok(state.error && /revoked/i.test(state.error), `expected revoked error, got: ${state.error}`)
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S12. LOGIN FAILURE + RATE LIMITING
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('login: wrong password is rejected', async () => {
      const fresh = new E2EClient(`http://127.0.0.1:${nextPort}`)
      const { state } = await actionPost(fresh, '/login', {
        email: 'pastor1@e2e.test',
        password: 'WrongPass123',
      })
      assert.ok(state.error, 'expected a login error')
      assert.ok(!state.success, 'login must not succeed with a wrong password')
    })

    await scenario('login: 11th attempt within the window is rate-limited', async () => {
      const fresh = new E2EClient(`http://127.0.0.1:${nextPort}`)
      let last: ActionState = {}
      for (let i = 0; i < 11; i++) {
        const r = await actionPost(fresh, '/login', {
          email: 'bruteforce@e2e.test',
          password: 'WrongPass123',
        })
        last = r.state
      }
      assert.ok(last.error && /too many attempts/i.test(last.error), `expected rate limit error, got: ${last.error}`)
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S13. DEAD ENDS AND BACKDOORS
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('backdoor: /api/church/activation/simulate is 404 without the flag', async () => {
      const res = await pastor1.postJson('/api/church/activation/simulate', { merchantReference: ids.merchantRef })
      assert.equal(res.status, 404, `simulate must be hidden, got ${res.status}: ${res.text}`)
    })

    await scenario('legacy: /api/topups is disabled (501)', async () => {
      const res = await pastor1.postJson('/api/topups', { amount: 100, provider: 'test' })
      assert.equal(res.status, 501, `expected 501, got ${res.status}`)
    })

    await scenario('signup: duplicate email is reported cleanly', async () => {
      const fresh = new E2EClient(`http://127.0.0.1:${nextPort}`)
      const { state } = await actionPost(fresh, '/signup', {
        email: 'pastor1@e2e.test',
        password: 'AnotherPass1!',
      })
      assert.ok(state.error && /already registered/i.test(state.error), `got: ${state.error}`)
    })

    await scenario('signup: weak password is rejected server-side', async () => {
      const fresh = new E2EClient(`http://127.0.0.1:${nextPort}`)
      const { state } = await actionPost(fresh, '/signup', {
        email: 'weak@e2e.test',
        password: 'short',
      })
      assert.ok(state.error && /at least 8 characters/i.test(state.error), `got: ${state.error}`)
    })

    // ═══════════════════════════════════════════════════════════════════════
    // S14. TENANT MISMATCH (suspended church cannot self-serve re-activation)
    // ═══════════════════════════════════════════════════════════════════════
    await scenario('suspended church: startActivationPayment is refused', async () => {
      await pool.query(`UPDATE church.churches SET activation_status = 'suspended' WHERE id = $1`, [
        ids.church2,
      ])
      const res = await pastor2.postJson('/api/church/activation/start', { phoneNumber: '0700000000' })
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`)
      assert.match(res.text, /suspended/i)
      const n = (
        await pool.query(`SELECT count(*)::int AS n FROM church.activation_payments WHERE church_id = $1`, [
          ids.church2,
        ])
      ).rows[0].n
      assert.equal(n, 0, 'no ledger row may be created for a suspended church')
      await pool.query(`UPDATE church.churches SET activation_status = 'pending_payment' WHERE id = $1`, [
        ids.church2,
      ])
    })
  } catch (err) {
    console.error('[e2e] harness error:', err)
    results.push({
      name: 'harness',
      passed: false,
      ms: Date.now() - started,
      error: String((err as Error)?.stack || err),
    })
  } finally {
    try {
      writeFileSync('/tmp/e2e-nextlog-final.txt', nextLog.join(''))
    } catch {
      /* best effort */
    }
    // ── teardown ────────────────────────────────────────────────────────────
    if (nextProc) {
      const p = nextProc
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4000)
        p.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        p.kill('SIGTERM')
      })
    }
    await mockSupa.stop().catch(() => undefined)
    await mockNajiki.stop().catch(() => undefined)
    await pool.end().catch(() => undefined)
    await pgInstance.stop().catch(() => undefined)
    try {
      rmSync(dbDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    if (hadEnvLocal && prevEnvLocalContent !== null) writeFileSync(prevEnvLocal, prevEnvLocalContent)
    else if (existsSync(prevEnvLocal)) rmSync(prevEnvLocal, { force: true })
  }

  const failed = results.filter((r) => !r.passed)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} scenarios passed in ${Date.now() - started}ms`)
  return { results, durationMs: Date.now() - started }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry
// ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  runE2E()
    .then((report) => {
      const failed = report.results.filter((r) => !r.passed)
      if (failed.length > 0) {
        console.error('\nFAILURES:')
        for (const f of failed) console.error(`  ✗ ${f.name}\n${String(f.error).split('\n').slice(0, 15).join('\n')}`)
        process.exit(1)
      }
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
