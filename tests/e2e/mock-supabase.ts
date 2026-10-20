/**
 * tests/e2e/mock-supabase.ts
 *
 * A faithful-enough stand-in for the two Supabase services the app talks to:
 *
 *   1. GoTrue  (/auth/v1/*)  — signup, password login, current user, logout,
 *      admin user lookup. Passwords are scrypt-hashed; sessions are real
 *      HS256 JWTs signed with the configured JWT secret.
 *
 *   2. PostgREST (/rest/v1/*) — the subset of the query protocol the app uses:
 *      table SELECT (eq/ilike/in/or/order/limit), INSERT, UPSERT
 *      (Prefer: resolution=merge-duplicates + on_conflict), UPDATE (PATCH),
 *      and RPC calls (GET for zero-arg, POST for arg-carrying).
 *
 * Crucially, REST requests are executed against a REAL PostgreSQL database
 * (embedded-postgres) as the role decoded from the JWT — so the RLS policies
 * in supabase-schema.sql are enforced for real, and auth.uid() works for real
 * (request.jwt.claims GUC, exactly like Supabase sets it).
 *
 * This is what makes the E2E suite "end to end": Next.js server code → HTTP →
 * mock Supabase protocol → real SQL + real RLS → back out again.
 */

import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import pg from 'pg'
import { SignJWT, jwtVerify } from 'jose'

export interface MockSupabaseConfig {
  /** JWT secret (HS256). */
  jwtSecret: string
  anonKey: string
  serviceRoleKey: string
  port: number
  pool: pg.Pool
}

interface StoredUser {
  id: string
  email: string
  passHash: string // salt:hash hex
  createdAt: string
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64).toString('hex')
  try {
    return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

/** Quote a SQL identifier (tables/columns are app-controlled whitelists anyway). */
function qident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`)
  return `"${name}"`
}

function qtext(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Parse a Postgres array literal ("{a,b,c}" — elements may be quoted with
 * doubled quotes and backslash escapes) into a string array.
 */
function parsePgArrayLiteral(literal: string): string[] {
  const inner = literal.slice(1, -1)
  if (inner.trim() === '') return []
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  let esc = false
  let started = false
  for (const ch of inner) {
    if (esc) {
      cur += ch
      esc = false
      continue
    }
    if (inQuotes) {
      if (ch === '"') {
        // doubled quote = literal quote
        cur += '"'
        inQuotes = false
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      started = true
      continue
    }
    if (ch === '\\') {
      esc = true
      started = true
      continue
    }
    if (ch === ',') {
      out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  out.push(cur)
  return out
}

export class MockSupabase {
  private server: Server | null = null
  private pool: pg.Pool
  private jwtSecret: Uint8Array
  private anonKey: string
  private serviceRoleKey: string
  private port: number
  private users = new Map<string, StoredUser>()
  /** email → user (unique email, like GoTrue) */
  private emails = new Map<string, string>()
  /** Recent REST requests, for test diagnostics. */
  readonly restLog: Array<{ method: string; path: string; role: string; status: number }> = []
  private traceSeq = 0

  /** Ordered trace of request starts, written to a file (diagnostics). */
  private trace(line: string): void {
    if (!process.env.E2E_MOCK_TRACE) return
    appendFileSync('/tmp/e2e-mock-trace.txt', `${String(++this.traceSeq).padStart(4)} ${Date.now()} ${line}\n`)
  }

  constructor(cfg: MockSupabaseConfig) {
    this.pool = cfg.pool
    this.jwtSecret = new TextEncoder().encode(cfg.jwtSecret)
    this.anonKey = cfg.anonKey
    this.serviceRoleKey = cfg.serviceRoleKey
    this.port = cfg.port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[mock-supabase] unhandled:', err)
        if (!res.headersSent) this.sendJson(res, 500, { error: 'mock internal error' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.removeListener('error', reject)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  // Test helpers -------------------------------------------------------------

  /** Seed a user directly (e.g. an overseer account) and return its id. */
  async seedUser(email: string, password: string): Promise<string> {
    const id = randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
    const row = await this.pool.query(
      `INSERT INTO auth.users (id, email, email_confirmed_at, created_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [id, email]
    )
    const userId = row.rows[0].id as string
    this.users.set(userId, { id: userId, email, passHash: hashPassword(password), createdAt: new Date().toISOString() })
    this.emails.set(email.toLowerCase(), userId)
    return userId
  }

  /** Direct SQL access for assertions. */
  sql(text: string, params: unknown[] = []) {
    return this.pool.query(text, params)
  }

  // HTTP ---------------------------------------------------------------------

  private sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    // Always emit valid JSON: real PostgREST wraps scalar RPC results in JSON
    // (e.g. a uuid as a quoted string), and postgrest-js JSON.parses the body.
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(payload)
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  private bearer(req: IncomingMessage): string | null {
    const auth = req.headers.authorization
    return auth && auth.startsWith('Bearer ') ? auth.slice(7) : null
  }

  private async decodeToken(token: string): Promise<{ role: string; claims: Record<string, any> } | null> {
    // In real Supabase the anon/service keys are themselves JWTs, so the
    // GoTrue admin API and PostgREST both accept them as Bearer. Accept the
    // raw keys here too.
    if (token === this.serviceRoleKey) return { role: 'service_role', claims: { role: 'service_role' } }
    if (token === this.anonKey) return { role: 'anon', claims: {} }
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret)
      return {
        role: typeof payload.role === 'string' ? payload.role : 'anon',
        claims: payload as Record<string, any>,
      }
    } catch {
      return null
    }
  }

  private async issueToken(claims: { sub: string; email: string; role: string }): Promise<string> {
    return new SignJWT({ ...claims, aud: claims.role, iss: 'mock-supabase' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(this.jwtSecret)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname

    if (path.startsWith('/auth/v1/')) return this.handleAuth(req, res, path.slice('/auth/v1'.length), url)
    if (path.startsWith('/rest/v1/')) return this.handleRest(req, res, path.slice('/rest/v1/'.length), url)
    this.sendJson(res, 404, { error: `mock: no route for ${path}` })
  }

  // ── GoTrue ────────────────────────────────────────────────────────────────

  private async handleAuth(req: IncomingMessage, res: ServerResponse, sub: string, url: URL): Promise<void> {
    const method = req.method || 'GET'

    // POST /auth/v1/signup
    if (sub === '/signup' && method === 'POST') {
      const body = JSON.parse((await this.readBody(req)) || '{}')
      const email = String(body.email || '').trim().toLowerCase()
      const password = String(body.password || '')

      if (!email || !password) return this.sendJson(res, 400, { error: 'email and password are required' })
      if (this.emails.has(email)) {
        // Real GoTrue reports duplicate signups as "User already registered"
        // (error code user_exists); the app maps that wording to a friendly
        // message, so the mock must speak the same dialect.
        return this.sendJson(res, 422, { error: 'User already registered' })
      }
      if (password.length < 6) {
        return this.sendJson(res, 422, { error: 'Password should be at least 6 characters' })
      }

      const id = randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      await this.pool.query(
        `INSERT INTO auth.users (id, email, email_confirmed_at, created_at) VALUES ($1, $2, now(), now())`,
        [id, email]
      )
      const user: StoredUser = { id, email, passHash: hashPassword(password), createdAt: new Date().toISOString() }
      this.users.set(id, user)
      this.emails.set(email, id)

      const accessToken = await this.issueToken({ sub: id, email, role: 'authenticated' })
      const refreshToken = randomBytes(32).toString('hex')
      return this.sendJson(res, 200, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 7200,
        refresh_token: refreshToken,
        user: { id, email, email_confirmed_at: user.createdAt, created_at: user.createdAt },
      })
    }

    // POST /auth/v1/token?grant_type=password
    if (sub === '/token' && method === 'POST') {
      const grant = url.searchParams.get('grant_type')
      if (grant !== 'password') return this.sendJson(res, 400, { error: 'unsupported grant_type' })

      const body = JSON.parse((await this.readBody(req)) || '{}')
      const email = String(body.email || '').trim().toLowerCase()
      const password = String(body.password || '')
      const user = this.users.get(this.emails.get(email) || '')

      if (!user || !verifyPassword(password, user.passHash)) {
        return this.sendJson(res, 400, { error: 'Invalid login credentials' })
      }

      const accessToken = await this.issueToken({ sub: user.id, email: user.email, role: 'authenticated' })
      const refreshToken = randomBytes(32).toString('hex')
      return this.sendJson(res, 200, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 7200,
        refresh_token: refreshToken,
        user: { id: user.id, email: user.email, email_confirmed_at: user.createdAt, created_at: user.createdAt },
      })
    }

    // GET /auth/v1/user  (Bearer access token)
    if (sub === '/user' && method === 'GET') {
      const token = this.bearer(req)
      if (!token) return this.sendJson(res, 401, { error: 'no auth token' })
      const decoded = await this.decodeToken(token)
      if (!decoded) return this.sendJson(res, 401, { error: 'invalid token' })
      const user = this.users.get(String(decoded.claims.sub))
      if (!user) return this.sendJson(res, 401, { error: 'user not found' })
      return this.sendJson(res, 200, {
        id: user.id,
        email: user.email,
        email_confirmed_at: user.createdAt,
        created_at: user.createdAt,
      })
    }

    // POST /auth/v1/logout
    if (sub === '/logout' && method === 'POST') {
      return this.sendJson(res, 204, {})
    }

    // GET /auth/v1/admin/users/:id  (service role)
    const adminMatch = sub.match(/^\/admin\/users\/([0-9a-f-]+)$/i)
    if (adminMatch && method === 'GET') {
      const token = this.bearer(req)
      if (!token) return this.sendJson(res, 401, { error: 'no auth token' })
      const decoded = await this.decodeToken(token)
      if (!decoded || decoded.role !== 'service_role') return this.sendJson(res, 403, { error: 'forbidden' })
      const user = this.users.get(adminMatch[1])
      if (!user) return this.sendJson(res, 404, { error: 'user not found' })
      return this.sendJson(res, 200, { id: user.id, email: user.email, created_at: user.createdAt })
    }

    this.sendJson(res, 404, { error: `mock: no auth route for ${sub}` })
  }

  // ── PostgREST ─────────────────────────────────────────────────────────────

  private async handleRest(req: IncomingMessage, res: ServerResponse, rest: string, url: URL): Promise<void> {
    const method = req.method || 'GET'
    const parts = rest.split('/').filter(Boolean)
    this.trace(`START ${method} /rest/v1/${rest}${url.search ? url.search : ''}`)

    // Determine role + claims (JWT > apikey > anon), like PostgREST.
    // Note: postgrest-js sends the raw API key as `Authorization: Bearer` when
    // no session exists, so a failed JWT decode must fall through to apikey.
    let role = 'anon'
    let claims: Record<string, any> | null = null
    const token = this.bearer(req)
    const apikey = (req.headers.apikey || req.headers['x-api-key'] || token || '') as string
    if (token) {
      const decoded = await this.decodeToken(token)
      if (decoded) {
        role = decoded.claims.role === 'service_role' ? 'service_role' : 'authenticated'
        claims = decoded.claims
      }
    }
    if (role === 'anon' && apikey === this.serviceRoleKey) {
      role = 'service_role'
    }

    const acceptObject = (req.headers.accept || '').includes('application/vnd.pgrst.object+json')
    const prefer = String(req.headers.prefer || '')
    const schema =
      (req.headers['accept-profile'] as string) ||
      (req.headers['content-profile'] as string) ||
      (url.searchParams.get('Replication-Identity') as string) ||
      'public'

    try {
      if (parts[0] === 'rpc' && parts[1]) {
        return await this.handleRpc(req, res, method, parts[1], schema, role, claims, url)
      }

      const table = parts[0]
      if (!table) return this.sendJson(res, 404, { message: 'not found', code: '404' })

      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL ROLE ${qident(role)}`)
        if (claims) {
          await client.query(`SET LOCAL request.jwt.claims = ${qtext(JSON.stringify(claims))}`)
        } else {
          await client.query(`SET LOCAL request.jwt.claims = '{}'`)
        }

        let status = 200
        let body: unknown = []

        if (method === 'GET' || method === 'HEAD') {
          const sql = this.buildSelect(client, schema, table, url, acceptObject)
          const rows = await this.runQuery(client, sql.text, sql.params)
          if (process.env.E2E_MOCK_VERBOSE) {
            console.log(`[mock-rest] ${role} GET ${schema}.${table} :: ${sql.text} :: ${JSON.stringify(sql.params)} -> ${rows.length} rows  [url: ${url.pathname}?${url.searchParams.toString()}]`)
          }
          if (acceptObject) {
            if (rows.length !== 1) {
              status = 406
              body = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: '' }
            } else {
              body = rows[0]
            }
          } else {
            body = rows
          }
        } else if (method === 'POST') {
          const rawBody = await this.readBody(req)
          const rowsIn = rawBody ? JSON.parse(rawBody) : null
          if (rowsIn === null) {
            status = 400
            body = { message: 'no rows to insert', code: '22P02' }
          } else {
            if (process.env.E2E_MOCK_VERBOSE) {
              console.log(`[mock-rest] ${role} POST ${schema}.${table} body=${String(rawBody).slice(0, 200)}`)
            }
            const list = Array.isArray(rowsIn) ? rowsIn : [rowsIn]
            const isUpsert = prefer.includes('resolution=merge-duplicates')
            const onConflict = url.searchParams.get('on_conflict') || ''
            const inserted = await this.runInsert(client, schema, table, list, isUpsert, onConflict)
            body = prefer.includes('return=representation') || prefer.includes('return=modified') ? inserted : ''
          }
        } else if (method === 'PATCH' || method === 'PUT') {
          const rawBody = await this.readBody(req)
          const setObj = rawBody ? JSON.parse(rawBody) : {}
          const sql = this.buildUpdate(client, schema, table, url, setObj, acceptObject)
          const rows = await this.runQuery(client, sql.text, sql.params)
          if (acceptObject) {
            if (rows.length !== 1) {
              status = 406
              body = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: '' }
            } else {
              body = rows[0]
            }
          } else {
            body = rows
          }
        } else {
          status = 405
          body = { message: 'method not allowed', code: '405' }
        }

        this.restLog.push({ method, path: `${schema}.${table}`, role, status })
        this.trace(`${method} ${schema}.${table} [${role}] -> ${status} body=${JSON.stringify(body)?.slice(0, 120)}`)
        await client.query(status >= 400 ? 'ROLLBACK' : 'COMMIT')
        if (status === 204 || body === '') {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end()
          return
        }
        this.sendJson(res, status, body)
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    } catch (err: any) {
      const pgErr = err as pg.DatabaseError
      if (pgErr && pgErr.code) {
        const status = pgErr.code === '42501' ? 403 : pgErr.code === '42P01' ? 404 : pgErr.code === '23505' ? 409 : 400
        return this.sendJson(res, status, {
          message: pgErr.message,
          code: pgErr.code,
          details: pgErr.detail || '',
          hint: pgErr.hint || '',
        })
      }
      console.error('[mock-supabase] REST error:', err)
      this.sendJson(res, 500, { message: String(err?.message || err), code: 'XX000' })
    }
  }

  private async runQuery(client: pg.PoolClient, text: string, params: unknown[]) {
    const result = await client.query(text, params)
    return result.rows
  }

  /**
   * Parse PostgREST-style filters from the query string.
   * Supports: eq, neq, ilike, like, in, is, gt, gte, lt, lte, or(...)
   */
  private parseFilters(url: URL): { where: string[]; params: unknown[]; select: string[]; orders: string[] } {
    const where: string[] = []
    const params: unknown[] = []
    let select: string[] = []
    const orders: string[] = []

    const selectParam = url.searchParams.get('select')
    if (selectParam === null || selectParam === '*') {
      select = ['*']
    } else {
      select = selectParam.split(',').map((s) => s.trim()).filter(Boolean)
    }

    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset' || key === 'on_conflict') continue

      if (key === 'order') {
        for (const part of value.split(',').filter(Boolean)) {
          const [col, dir] = part.split('.')
          const column = col.includes('.') ? col.split('.').slice(1).join('.') : col
          const direction = (dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
          orders.push(`${qident(column.split(',')[0])} ${direction}`)
        }
        continue
      }

      // or(...) compound filter: ?or=(col1.eq.x,col2.ilike.y,...)
      if (key === 'or') {
        const inner = value.replace(/^\(|\)$/g, '')
        const conditions: string[] = []
        for (const cond of inner.split(',')) {
          const [col, subOp, ...restParts] = cond.split('.')
          const val = restParts.join('.')
          if (subOp === 'is') {
            conditions.push(`${qident(col)} IS ${val === 'null' ? 'NULL' : 'NOT NULL'}`)
          } else {
            params.push(val)
            const ph = `$${params.length}`
            if (subOp === 'eq') conditions.push(`${qident(col)} = ${ph}`)
            else if (subOp === 'neq') conditions.push(`${qident(col)} <> ${ph}`)
            else if (subOp === 'ilike') conditions.push(`${qident(col)} ILIKE ${ph}`)
            else if (subOp === 'like') conditions.push(`${qident(col)} LIKE ${ph}`)
          }
        }
        where.push(`(${conditions.join(' OR ')})`)
        continue
      }

      // PostgREST column filter: ?column=op.value
      // (e.g. slug=ilike.foo, id=in.(a,b), x=is.null, created_at=gte.2024-01-01)
      const m = value.match(/^(eq|neq|ilike|like|in|is|gt|gte|lt|lte|not)(?:\.(.*))?$/s)
      let op = m ? m[1] : 'eq'
      let rest = m && m[2] !== undefined ? m[2] : value
      let negate = false
      if (op === 'not') {
        negate = true
        const inner = rest.match(/^(is|eq|neq|in|gt|gte|lt|lte)(?:\.(.*))?$/s)
        op = inner ? inner[1] : 'is'
        rest = inner && inner[2] !== undefined ? inner[2] : 'null'
      }

      if (op === 'in') {
        const items = rest.replace(/^\(|\)$/g, '').split(',').filter(Boolean)
        const phs: string[] = []
        for (const item of items) {
          params.push(item)
          phs.push(`$${params.length}`)
        }
        const clause = items.length ? `${qident(key)} IN (${phs.join(', ')})` : 'FALSE'
        where.push(negate ? `NOT (${clause})` : clause)
        continue
      }

      if (op === 'is') {
        const clause = `${qident(key)} IS ${rest === 'null' ? 'NULL' : 'NOT NULL'}`
        where.push(negate ? `NOT (${clause})` : clause)
        continue
      }

      params.push(rest)
      const ph = `$${params.length}`
      let clause: string
      if (op === 'eq') clause = `${qident(key)} = ${ph}`
      else if (op === 'neq') clause = `${qident(key)} <> ${ph}`
      else if (op === 'ilike') clause = `${qident(key)} ILIKE ${ph}`
      else if (op === 'like') clause = `${qident(key)} LIKE ${ph}`
      else if (op === 'gt') clause = `${qident(key)} > ${ph}`
      else if (op === 'gte') clause = `${qident(key)} >= ${ph}`
      else if (op === 'lt') clause = `${qident(key)} < ${ph}`
      else clause = `${qident(key)} <= ${ph}`
      where.push(negate ? `NOT (${clause})` : clause)
    }

    return { where, params, select, orders }
  }

  private buildSelect(client: pg.PoolClient, schema: string, table: string, url: URL, _acceptObject: boolean) {
    const { where, params, select, orders } = this.parseFilters(url)
    const columns = select.map((c) => (c === '*' ? '*' : qident(c.split(',')[0]))).join(', ')
    const limit = url.searchParams.get('limit')
    const offset = url.searchParams.get('offset')

    let sql = `SELECT ${columns} FROM ${qident(schema === 'public' ? 'public' : schema)}.${qident(table)}`
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    if (orders.length) sql += ` ORDER BY ${orders.join(', ')}`
    if (limit) sql += ` LIMIT ${Number(limit)}`
    if (offset) sql += ` OFFSET ${Number(offset)}`

    return { text: sql, params }
  }

  private buildUpdate(client: pg.PoolClient, schema: string, table: string, url: URL, setObj: Record<string, unknown>, _acceptObject: boolean) {
    const { where, params: filterParams, orders } = this.parseFilters(url)
    const limit = url.searchParams.get('limit')

    const setKeys = Object.keys(setObj)
    if (setKeys.length === 0) throw new Error('empty update body')

    const phs: string[] = []
    const params: unknown[] = []
    for (const key of setKeys) {
      params.push(setObj[key])
      phs.push(`${qident(key)} = $${params.length}`)
    }

    // Combine filter params after set params.
    const allParams = [...params, ...filterParams]
    const shiftedWhere = where.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + params.length}`))

    let sql = `UPDATE ${qident(schema)}. ${qident(table)}`.replace(/\s+/g, ' ')
    sql = `UPDATE ${qident(schema)}.${qident(table)} SET ${phs.join(', ')}`
    if (shiftedWhere.length) sql += ` WHERE ${shiftedWhere.join(' AND ')}`
    sql += ` RETURNING *`
    if (orders.length) sql += ` ORDER BY ${orders.join(', ')}`
    if (limit) sql += ` LIMIT ${Number(limit)}`

    return { text: sql, params: allParams }
  }

  private async runInsert(
    client: pg.PoolClient,
    schema: string,
    table: string,
    rows: Record<string, unknown>[],
    isUpsert: boolean,
    onConflict: string
  ): Promise<unknown[]> {
    const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
    const resultRows: unknown[] = []

    for (const row of rows) {
      const phs: string[] = []
      const params: unknown[] = []
      for (const key of keys) {
        params.push(row[key] ?? null)
        phs.push(`$${params.length}`)
      }

      const columnList = keys.map(qident).join(', ')
      const valueList = phs.join(', ')

      let sql = `INSERT INTO ${qident(schema)}.${qident(table)} (${columnList}) VALUES (${valueList}) RETURNING *`
      if (isUpsert) {
        const conflictCols = onConflict ? onConflict.split(',').map(qident).join(', ') : undefined
        sql += conflictCols ? ` ON CONFLICT (${conflictCols}) DO UPDATE SET ` : ' ON CONFLICT DO UPDATE SET '
        sql += keys.map((k) => `${qident(k)} = EXCLUDED.${qident(k)}`).join(', ')
      }

      const res = await client.query(sql, params)
      resultRows.push(...res.rows)
    }

    return resultRows
  }

  private async handleRpc(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    fn: string,
    schema: string,
    role: string,
    claims: Record<string, any> | null,
    url: URL
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${qident(role)}`)
      if (claims) {
        await client.query(`SET LOCAL request.jwt.claims = ${qtext(JSON.stringify(claims))}`)
      } else {
        await client.query(`SET LOCAL request.jwt.claims = '{}'`)
      }

      const resolvedFn = schema === 'public' ? `public.${fn}` : `${schema}.${fn}`
      let result: unknown
      this.restLog.push({ method: 'RPC', path: `${schema}.${fn}`, role, status: 0 })

      const rawBody = method === 'GET' ? '' : await this.readBody(req)
      const argsObj: Record<string, unknown> = rawBody ? JSON.parse(rawBody) : {}
      const argNames = Object.keys(argsObj)
      const params: unknown[] = argNames.map((n) => argsObj[n])

      // Resolve the overload: match name + IN-argument count, read the IN
      // argument types so placeholders are cast like PostgREST types them.
      //
      // COUNTING ARGUMENTS: proargnames/proargtypes also list the OUTPUT
      // columns of RETURNS TABLE functions (stored as OUT arguments), so the
      // raw lengths do NOT equal the number of call arguments. The real
      // input count is the total minus the 'o' entries of proargmodes
      // (NULL proargmodes ⇒ every argument is input/variadic).
      const meta = await client.query(
        `SELECT p.proretset,
                (
                  SELECT COALESCE(array_length(p.proargtypes, 1), 0)
                         - COALESCE((SELECT count(*) FROM unnest(p.proargmodes) m(mode) WHERE m.mode = 'o'), 0)
                ) AS in_arg_count,
                (
                  SELECT array_agg(t.typname ORDER BY s.i)
                  FROM generate_subscripts(p.proargtypes, 1) s(i)
                  JOIN pg_type t ON t.oid = p.proargtypes[s.i]
                  WHERE COALESCE(p.proargmodes IS NULL, true)
                     OR p.proargmodes[s.i] IN ('i', 'v', 'b')
                ) AS arg_types
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2
            AND (
              (COALESCE(array_length(p.proargtypes, 1), 0)
               - COALESCE((SELECT count(*) FROM unnest(p.proargmodes) m2(mode) WHERE m2.mode = 'o'), 0)) = $3
            )
          LIMIT 1`,
        [schema, fn, argNames.length]
      )

      this.trace(`RPC ${fn} [${role}] meta schema=${schema} args=${argNames.length} proargnames-match=${meta.rows.length}`)
      if (!meta.rows.length) {
        await client.query('ROLLBACK')
        this.trace(`RPC ${fn} [${role}] -> 404 not found (schema=${schema}, argcount=${argNames.length})`)
        this.sendJson(res, 404, { message: `function ${schema}.${fn}(...) does not exist`, code: '42883' })
        return
      }

      const proretset: boolean = meta.rows[0].proretset
      // array_agg yields a JS string[] for IN args, or null when the function
      // takes no input arguments (e.g. RETURNS TABLE functions). Guard against
      // a raw Postgres array literal string just in case.
      const rawArgTypes: unknown = meta.rows[0].arg_types
      let argTypes: (string | null)[]
      if (Array.isArray(rawArgTypes)) {
        argTypes = rawArgTypes as (string | null)[]
      } else if (typeof rawArgTypes === 'string') {
        const inner = rawArgTypes.trim()
        argTypes = inner.startsWith('{') && inner.endsWith('}') ? parsePgArrayLiteral(inner) : [inner]
      } else {
        argTypes = []
      }
      const phs = argNames.map((_, i) => {
        const t = argTypes[i]
        return t ? `$${i + 1}::${t}` : `$${i + 1}`
      })
      const callExpr = `${resolvedFn}(${phs.join(', ')})`

      if (proretset) {
        const setProbe = await client.query(`SELECT * FROM ${callExpr}`, params)
        result = setProbe.rows
      } else {
        const probe = await client.query(`SELECT ${callExpr} AS __result__`, params)
        result = probe.rows[0] ? probe.rows[0].__result__ : null
      }

      await client.query('COMMIT')
      this.trace(`RPC ${fn} [${role}] -> 200 body=${JSON.stringify(result)?.slice(0, 160)}`)
      this.sendJson(res, 200, result)
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined)
      const pgErr = err as pg.DatabaseError
      if (pgErr && pgErr.code) {
        const status = pgErr.code === '42501' ? 403 : pgErr.code === '42883' ? 404 : 400
        this.trace(`RPC ${fn} [${role}] -> ${status} pgerr=${pgErr.code} ${pgErr.message}`)
        this.sendJson(res, status, {
          message: pgErr.message,
          code: pgErr.code,
          details: pgErr.detail || '',
          hint: pgErr.hint || '',
        })
        return
      }
      console.error('[mock-supabase] RPC error:', err)
      this.trace(`RPC ${fn} [${role}] -> 500 ${String(err?.message || err)?.slice(0, 160)}`)
      this.sendJson(res, 500, { message: String(err?.message || err), code: 'XX000' })
    } finally {
      client.release()
    }
  }
}

/**
 * Split a SQL script into top-level statements.
 *
 * Handles the constructs these schema files actually use: `--` line comments,
 * `/* *\/` block comments, `'...'` string literals (with `''` escapes), and
 * `$$ ... $$` / `$tag$ ... $tag$` dollar-quoted bodies. Semicolons inside any
 * of those never terminate a statement.
 */
export function splitSqlStatements(src: string): string[] {
  const stmts: string[] = []
  let cur = ''
  let i = 0
  let dq: string | null = null
  let inLine = false
  let inBlock = false

  const pushDq = () => {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i))
    dq = m ? m[0] : '$$'
    cur += dq
    i += dq.length
  }

  while (i < src.length) {
    const ch = src[i]

    if (inLine) {
      cur += ch
      if (ch === '\n') inLine = false
      i++
      continue
    }
    if (inBlock) {
      if (src.startsWith('*/', i)) {
        cur += '*/'
        i += 2
        inBlock = false
      } else {
        cur += ch
        i++
      }
      continue
    }
    if (dq) {
      // Explicit annotation: TS over-narrows the closure-captured `dq` here.
      const openDq: string = dq
      if (src.startsWith(openDq, i)) {
        cur += openDq
        i += openDq.length
        dq = null
        continue
      }
      cur += ch
      i++
      continue
    }

    if (src.startsWith('--', i)) {
      inLine = true
      cur += ch
      i++
      continue
    }
    if (src.startsWith('/*', i)) {
      inBlock = true
      cur += '/*'
      i += 2
      continue
    }
    if (ch === '$') {
      pushDq()
      continue
    }
    if (ch === "'") {
      cur += ch
      i++
      while (i < src.length) {
        cur += src[i]
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            cur += "'"
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === ';') {
      if (cur.trim()) stmts.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) stmts.push(cur.trim())
  return stmts
}

/**
 * Initialise a fresh embedded-Postgres database with the Supabase role model
 * and the application's full schema + migrations, in the correct order.
 *
 * Scripts are applied statement-by-statement with each statement
 * auto-committed — the same semantics as Supabase's SQL Editor. That matters:
 * migration 010 adds an enum value ('overseer') and a later function
 * references it, and Postgres forbids using a freshly-added enum value inside
 * the SAME transaction as the ADD VALUE.
 */
export async function initDatabase(
  pool: pg.Pool,
  schemaSql: string,
  migrations: Array<{ name: string; sql: string }>
): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('SELECT 1')
  } finally {
    c.release()
  }

  const run = async (sqlText: string, label: string) => {
    for (const stmt of splitSqlStatements(sqlText)) {
      try {
        await pool.query(stmt)
      } catch (err: any) {
        throw new Error(
          `[e2e:db] ${label} failed: ${err.message}\n--- statement head ---\n${stmt.slice(0, 300)}...`
        )
      }
    }
  }

  // Supabase role model.
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOINHERIT NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOINHERIT NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOINHERIT NOLOGIN BYPASSRLS;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  `, 'roles')

  // auth schema + users table + auth.uid() (as Supabase provides them).
  await run(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE,
      encrypted_password text,
      email_confirmed_at timestamptz,
      raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    GRANT SELECT ON auth.users TO postgres, service_role;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$ SELECT current_setting('request.jwt.claims', true)::jsonb $$;
  `, 'auth-schema')

  // The base schema file is written for re-application on a live Supabase
  // project: several RLS policies reference church.my_tenant_id() BEFORE the
  // function is defined later in the same file (policies are validated at
  // CREATE time). On a truly fresh database we pre-create it, mirroring the
  // definition from the schema file itself.
  await run(`
    CREATE SCHEMA IF NOT EXISTS church;
    CREATE OR REPLACE FUNCTION church.my_tenant_id()
    RETURNS uuid AS $$
    BEGIN
      RETURN (
        SELECT tenant_id::uuid
        FROM public.admin_profiles
        WHERE id = auth.uid()
        LIMIT 1
      );
    END;
    $$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, church;
  `, 'church.my_tenant_id() pre-create')

  // pg_cron ships with Supabase but not with stock PostgreSQL. The schema's
  // DO block already no-ops its schedules when the extension is absent, so we
  // only neutralise the CREATE EXTENSION line for the E2E database.
  const sanitizedSchema = schemaSql.replace(
    /^CREATE EXTENSION IF NOT EXISTS pg_cron;[ \t]*$/m,
    '-- CREATE EXTENSION IF NOT EXISTS pg_cron; (unavailable in E2E postgres; schedules are skipped by the guarded DO block)'
  )

  // Base schema.
  await run(sanitizedSchema, 'supabase-schema.sql')

  // Migrations in the fresh-database order documented in README:
  // 005, 006, 007, 009, 010, 008.
  for (const mig of migrations) {
    await run(mig.sql, mig.name)
  }

  // Convenience indexes/permissions the app expects.
  await run(`
    GRANT USAGE ON SCHEMA church TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA business TO anon, authenticated, service_role;
  `, 'grants')
}
