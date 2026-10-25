/**
 * lib/najiki/client.ts
 *
 * The single, contract-conformant HTTP client for the Na'jiki Finance gateway
 * (https://github.com/jikiservant-cmyk/najiki-finance2).
 *
 * This client is restricted to payment endpoints. SMS dispatch is exclusively
 * handled by the Supabase Edge Function `church-najiki-dispatch`.
 * See NAJIKI_INTEGRATION.md for the full contract this implements.
 *
 * ⚠️ This module deliberately imports NOTHING from `next/*` or
 * `@supabase/*`. It is plain `fetch` + `process.env` so it can be exercised by
 * the contract tests in `tests/` with Node's built-in runner.
 *
 * ── Contract summary (source: najiki-finance2) ────────────────────────────────
 * POST {base}/api/payments         → 200 { paymentId, reference, status }
 * GET  {base}/api/payments/:ref    → 200 { id, reference, status, amount, ... }
 *
 * Auth: `Authorization: Bearer <application api key>`.
 * Idempotency: payment initiation requires the `idempotencyKey` body field.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Na'jiki is deployed at this origin. Overridable with NAJIKI_API_URL so a
 * self-hosted or preview deployment can be pointed at without a code change.
 */
export const NAJIKI_DEFAULT_BASE_URL = 'https://najiki.netlify.app'

/**
 * The `code` of the church application row in Na'jiki's `applications` table.
 * `scripts/seed.ts` in najiki-finance2 seeds it as lowercase `church`
 * (`code: 'church', name: 'Church App'`).
 *
 * `/api/payments` filters its API-key lookup on `{ code: body.applicationCode }`,
 * so a mismatch surfaces as 401. Sending `CHURCH` is rejected. SMS application
 * credentials are consumed only by the Supabase Edge Function.
 */
export const NAJIKI_DEFAULT_APPLICATION_CODE = 'church'

/** Money is always UGX in churchOs; Na'jiki defaults to UGX as well. */
export const NAJIKI_DEFAULT_CURRENCY = 'UGX'

export interface NajikiConfig {
  /** Origin without a trailing slash, e.g. https://najiki.netlify.app */
  baseUrl: string
  /** Partner API key — sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string
  /** Application code, must equal the authenticated application's `code`. */
  applicationCode: string
  /** Outbound-webhook signing secret (falls back to the API key). */
  webhookSecret: string
  /** Per-request timeout in ms. */
  timeoutMs: number
}

/** Thrown when Na'jiki is not configured — never fall back to a bogus URL. */
export class NajikiConfigError extends Error {
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      `Na'jiki Finance is not configured: missing ${missing.join(', ')}. ` +
        'Set them in your environment (see .env.example).'
    )
    this.name = 'NajikiConfigError'
    this.missing = missing
  }
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Read and validate the Na'jiki connection settings.
 *
 * Throws {@link NajikiConfigError} naming every missing variable rather than
 * failing later with an opaque "fetch failed" — this keeps payment setup
 * errors explicit and fail-closed. SMS configuration is validated in the Edge Function.
 */
export function getNajikiConfig(): NajikiConfig {
  const apiKey = (process.env.NAJIKI_API_KEY ?? '').trim()
  const missing: string[] = []
  if (!apiKey) missing.push('NAJIKI_API_KEY')

  if (missing.length > 0) throw new NajikiConfigError(missing)

  const baseUrl = stripTrailingSlashes(
    (process.env.NAJIKI_API_URL ?? '').trim() || NAJIKI_DEFAULT_BASE_URL
  )

  // The webhook secret is a *separate* credential in Na'jiki
  // (Application.webhookSecretEncrypted, AES-256-GCM at rest). Na'jiki falls
  // back to the plaintext API key for rows provisioned before that column
  // existed, so we mirror that fallback instead of hard-failing.
  const webhookSecret =
    (process.env.NAJIKI_WEBHOOK_SECRET ?? '').trim() || apiKey

  return {
    baseUrl,
    apiKey,
    applicationCode:
      (process.env.NAJIKI_APPLICATION_CODE ?? '').trim() ||
      NAJIKI_DEFAULT_APPLICATION_CODE,
    webhookSecret,
    timeoutMs: Number.parseInt(process.env.NAJIKI_TIMEOUT_MS ?? '', 10) > 0
      ? Number.parseInt(process.env.NAJIKI_TIMEOUT_MS ?? '', 10)
      : 15_000,
  }
}

/** True when the minimum credentials are present (no throw). */
export function isNajikiConfigured(): boolean {
  try {
    getNajikiConfig()
    return true
  } catch {
    return false
  }
}

/**
 * The application code to put in a request body. Does not throw, so callers can
 * decide what to do when Na'jiki is not configured at all.
 */
export function najikiApplicationCode(): string {
  return (
    (process.env.NAJIKI_APPLICATION_CODE ?? '').trim() ||
    NAJIKI_DEFAULT_APPLICATION_CODE
  )
}

/**
 * Payment types with special routing semantics in najiki-finance2.
 * Source: src/lib/constants.ts at the pinned contract revision.
 * These codes use Na'jiki's platform credentials/wallet, not a tenant wallet.
 */
export const NAJIKI_PLATFORM_PAYMENT_TYPE_CODES = [
  'SMS',
  'BUY_SMS',
  'SMS_TOPUP',
  'ACTIVATION',
  'ACCOUNT_ACTIVATION',
  'SUBSCRIPTION',
  'MONTHLY_SUBSCRIPTION',
  'PLATFORM_FEE',
] as const

const platformPaymentTypeCodeSet: ReadonlySet<string> = new Set(
  NAJIKI_PLATFORM_PAYMENT_TYPE_CODES
)

export type NajikiPaymentPurpose = 'topup' | 'donation' | 'activation'

const DEFAULT_PAYMENT_TYPE_CODES: Record<NajikiPaymentPurpose, string> = {
  topup: 'BUY_SMS',
  donation: 'donation',
  activation: 'ACCOUNT_ACTIVATION',
}

const LEGACY_PAYMENT_TYPE_CODES: Partial<Record<NajikiPaymentPurpose, Record<string, string>>> = {
  topup: { TOPUP: 'BUY_SMS' },
  activation: { CHURCH_ACTIVATION: 'ACCOUNT_ACTIVATION' },
}

/**
 * Resolve a payment type against Na'jiki's real contract. Payment types are
 * application-scoped and auto-registered by the gateway when unknown, so they
 * do not need to be created manually first. Their codes still have semantics:
 * SMS-credit purchases and activation fees must use a Na'jiki platform-fee code
 * so they do not route to or credit the church tenant; donations must remain
 * ordinary tenant collections.
 */
export function najikiPaymentTypeCode(kind: NajikiPaymentPurpose): string {
  const envName = `NAJIKI_PAYMENT_TYPE_${kind.toUpperCase()}`
  let code = (process.env[envName] ?? '').trim() || DEFAULT_PAYMENT_TYPE_CODES[kind]
  const legacyCode = LEGACY_PAYMENT_TYPE_CODES[kind]?.[code.toUpperCase()]
  if (legacyCode) {
    console.warn(`[Najiki] ${envName}=${code} is legacy; using ${legacyCode} to preserve platform-fee routing.`)
    code = legacyCode
  }
  const isPlatformType = platformPaymentTypeCodeSet.has(code.toUpperCase())

  if ((kind === 'topup' || kind === 'activation') && !isPlatformType) {
    throw new Error(
      `${envName} must be a Na'jiki platform-fee payment type ` +
        `(${[...NAJIKI_PLATFORM_PAYMENT_TYPE_CODES].join(', ')}); received "${code}"`
    )
  }
  if (kind === 'donation' && isPlatformType) {
    throw new Error(`${envName} must be a tenant collection type, not a Na'jiki platform-fee type`)
  }

  return code
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export interface NajikiApiErrorBody {
  error?: string
  message?: string
  details?: unknown
  [key: string]: unknown
}

/**
 * A Na'jiki response that was not 2xx.
 *
 * Carries the status, the `error` string and the `details` array Na'jiki
 * returns for validation failures
 * (`{ error: 'Validation failed', details: ['amount: ...', ...] }`) so callers
 * can surface something a human can act on instead of swallowing it.
 */
export class NajikiApiError extends Error {
  readonly status: number
  readonly error: string
  readonly details: string[]
  readonly body: NajikiApiErrorBody

  constructor(status: number, body: NajikiApiErrorBody, context: string) {
    const error = String(body?.error ?? body?.message ?? `HTTP ${status}`)
    const details = Array.isArray(body?.details)
      ? body.details.map((d) => String(d))
      : []
    super(
      `Na'jiki ${context} failed (${status}): ${error}` +
        (details.length > 0 ? ` — ${details.join('; ')}` : '')
    )
    this.name = 'NajikiApiError'
    this.status = status
    this.error = error
    this.details = details
    this.body = body ?? {}
  }

  /** True for 4xx — retrying the identical request cannot succeed. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

export interface NajikiRequestOptions {
  /** Overrides the configured timeout. */
  timeoutMs?: number
  /** Extra headers (never used to carry credentials). */
  headers?: Record<string, string>
}

/**
 * Perform a payment-only request. SMS paths are rejected here by design;
 * production SMS delivery belongs exclusively to the Supabase Edge Function.
 */
async function najikiPaymentRequest<T = unknown>(
  path: string,
  body?: unknown,
  options: NajikiRequestOptions = {}
): Promise<T> {
  if (path !== '/api/payments' && !/^\/api\/payments\/[^/?#]+$/.test(path)) {
    throw new Error('This Na’jiki client is payment-only. SMS must use the Supabase Edge Function.');
  }
  const config = getNajikiConfig()
  const url = `${config.baseUrl}${path}`

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...options.headers,
  }

  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const timeoutMs = options.timeoutMs ?? config.timeoutMs

  let response: Response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
  } catch (networkError: any) {
    // Network/TLS/timeout: the request may or may not have been accepted.
    // Na'jiki treats an ambiguous initiate the same way (status stays
    // 'processing'), so surface it as retryable rather than as a rejection.
    const reason = networkError?.message ?? String(networkError)
    console.error(
      `[Najiki] Network error calling ${path} (${reason}). ` +
        'The request may not have reached Na\'jiki — safe to retry with the same idempotency key.'
    )
    throw new Error(`Na'jiki ${path} unreachable: ${reason}`)
  }

  const raw = await response.text()
  let parsed: NajikiApiErrorBody = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) as NajikiApiErrorBody
    } catch {
      parsed = { error: `Non-JSON response from Na'jiki: ${raw.slice(0, 300)}` }
    }
  }

  if (!response.ok) {
    // Logged, never silent: a rejected payload must be visible in the server
    // log with the reason Na'jiki gave.
    console.error(
      `[Najiki] ${path} rejected with ${response.status}:`,
      JSON.stringify(parsed).slice(0, 1000)
    )
    throw new NajikiApiError(response.status, parsed, path)
  }

  return parsed as T
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments  ·  GET /api/payments/:reference
// ─────────────────────────────────────────────────────────────────────────────

export interface NajikiCreatePaymentRequest {
  applicationCode: string
  tenantCode?: string | null
  paymentTypeCode: string
  /** The church id in churchOs' own database — stored opaquely by Na'jiki. */
  externalEntityId: string
  /** Major units. UGX has no minor unit, so 5000 means UGX 5,000. */
  amount: number
  currency?: string
  /** E.164 without the leading '+'; Na'jiki handles downstream normalization. */
  phoneNumber: string
  /** Min 8 chars, generated by the caller, one per attempt. */
  idempotencyKey: string
  description?: string
  metadata?: Record<string, unknown>
}

/** The 200 body Na'jiki returns from POST /api/payments. */
export interface NajikiCreatePaymentResponse {
  paymentId: string
  reference: string
  status: string
  /** Downstream provider transaction ID, distinct from Na'jiki's paymentId. */
  providerPaymentId?: string | null
}

/** GET /api/payments/:reference — scoped to the calling application. */
export interface NajikiPaymentStatus {
  id: string
  reference: string
  status: string
  amount: number
  currency: string
  phoneNumber: string
  externalEntityId: string | null
  providerPaymentId: string | null
  failureReason: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/**
 * Create a payment intent.
 *
 * `applicationCode` is REQUIRED by Na'jiki (`z.string().min(1)`) and must match
 * the authenticated application, otherwise the API-key lookup is filtered to
 * nothing and Na'jiki answers 401.
 */
export async function createNajikiPayment(
  request: NajikiCreatePaymentRequest,
  options: NajikiRequestOptions = {}
): Promise<NajikiCreatePaymentResponse> {
  const payload: Record<string, unknown> = {
    applicationCode: request.applicationCode,
    paymentTypeCode: request.paymentTypeCode,
    externalEntityId: request.externalEntityId,
    amount: request.amount,
    currency: request.currency ?? NAJIKI_DEFAULT_CURRENCY,
    phoneNumber: request.phoneNumber,
    idempotencyKey: request.idempotencyKey,
    metadata: request.metadata ?? {},
  }

  if (request.tenantCode) payload.tenantCode = request.tenantCode
  if (request.description) payload.description = request.description

  // The payment endpoint's idempotency source is the required body field.
  return najikiPaymentRequest<NajikiCreatePaymentResponse>('/api/payments', payload, options)
}

/**
 * Read a payment's current status. Na'jiki scopes the lookup to the calling
 * application and answers 404 (not 403) for another application's payment.
 */
export async function getNajikiPayment(
  reference: string,
  options: NajikiRequestOptions = {}
): Promise<NajikiPaymentStatus> {
  return najikiPaymentRequest<NajikiPaymentStatus>(
    `/api/payments/${encodeURIComponent(reference)}`,
    undefined,
    options
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Request builders — the payload shapes churchOs actually sends
//
// These live here (rather than inline in the server actions) so there is one
// definition of each payload and it can be exercised against Na'jiki's real
// validation schema in tests/.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChurchTopupPaymentInput {
  churchId: string
  /** Na'jiki tenant code — `tenants.code` in churchOs, else the church slug. */
  tenantCode: string
  churchSlug?: string | null
  /** churchOs' own ledger reference (`wallet_transactions.reference_code`). */
  reference: string
  idempotencyKey: string
  /** UGX, major units. UGX has no minor unit: 5000 means UGX 5,000. */
  amount: number
  /** Digits-only E.164, e.g. 256772123456. */
  phoneNumber: string
}

/**
 * Admin "buy SMS credits" top-up.
 *
 * `paymentTypeCode` is one of Na'jiki's PLATFORM_FEE_TYPES, so this purchase
 * uses platform credentials/wallet instead of the church tenant's collection.
 */
export function buildChurchTopupPayment(
  input: ChurchTopupPaymentInput
): NajikiCreatePaymentRequest {
  return {
    applicationCode: najikiApplicationCode(),
    tenantCode: input.tenantCode,
    paymentTypeCode: najikiPaymentTypeCode('topup'),
    externalEntityId: input.churchId,
    amount: input.amount,
    currency: NAJIKI_DEFAULT_CURRENCY,
    phoneNumber: input.phoneNumber,
    idempotencyKey: input.idempotencyKey,
    description: `SMS wallet top-up for ${input.churchSlug || input.churchId}`,
    metadata: {
      churchId: input.churchId,
      tenantCode: input.tenantCode,
      product: 'sms_topup',
      source: 'admin-dashboard',
      // Our ledger reference — Na'jiki returns caller metadata alongside its
      // own metadata, and it generates its own `reference`, so this is the
      // reliable reconciliation key for the settlement webhook.
      churchReference: input.reference,
      idempotencyKey: input.idempotencyKey,
    },
  }
}

export interface ChurchDonationPaymentInput {
  churchId: string
  tenantCode: string
  churchName?: string | null
  /** churchOs' own ledger reference (`wallet_transactions.reference_code`). */
  reference: string
  idempotencyKey: string
  amount: number
  /** Digits-only E.164, e.g. 256772123456. */
  phoneNumber: string
  category?: string | null
}

/**
 * Public giving-portal donation.
 *
 * `metadata.donorPhone` is what lets the settlement webhook send the donor an
 * SMS receipt once — and only once — the payment is confirmed.
 */
export function buildChurchDonationPayment(
  input: ChurchDonationPaymentInput
): NajikiCreatePaymentRequest {
  return {
    applicationCode: najikiApplicationCode(),
    tenantCode: input.tenantCode,
    paymentTypeCode: najikiPaymentTypeCode('donation'),
    externalEntityId: input.churchId,
    amount: input.amount,
    currency: NAJIKI_DEFAULT_CURRENCY,
    phoneNumber: input.phoneNumber,
    idempotencyKey: input.idempotencyKey,
    description: `${input.churchName || 'Church'} ${input.category || 'giving'}`,
    metadata: {
      churchId: input.churchId,
      tenantCode: input.tenantCode,
      category: input.category || 'general',
      product: 'donation',
      source: 'public_giving',
      churchReference: input.reference,
      idempotencyKey: input.idempotencyKey,
      donorPhone: input.phoneNumber,
    },
  }
}
