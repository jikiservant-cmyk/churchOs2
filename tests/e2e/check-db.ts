/**
 * tests/e2e/check-db.ts
 *
 * Fast pre-flight: boots embedded-postgres and applies supabase-schema.sql +
 * migrations in the documented fresh-DB order (005,006,007,009,010,008). This
 * is the part of the E2E most likely to fail on schema drift, so it runs
 * standalone (no next dev, no mocks) for fast iteration.
 *
 *   node tests/e2e/check-db.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { initDatabase } from './mock-supabase.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function main() {
  const port = 55000 + Math.floor(Math.random() * 500)
  const dbDir = mkdtempSync(join(tmpdir(), 'churchos-chkdb-'))
  const pgInstance = new EmbeddedPostgres({
    databaseDir: dbDir,
    user: 'postgres',
    password: 'postgres',
    port,
    authMethod: 'scram-sha-256',
    persistent: false,
  })

  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' })
  pool.on('error', () => {
    /* idle-client errors are handled per-query */
  })

  try {
    await pgInstance.initialise()
    await pgInstance.start()
    console.log('[check-db] postgres up on', port)

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
    console.log('[check-db] schema + migrations applied cleanly')

    // Spot-check the objects the app depends on.
    const checks: Array<[string, string]> = [
      ["churches.activation_status", `SELECT count(*)::int FROM information_schema.columns WHERE table_schema='church' AND table_name='churches' AND column_name='activation_status'`],
      ["churches.denomination_id", `SELECT count(*)::int FROM information_schema.columns WHERE table_schema='church' AND table_name='churches' AND column_name='denomination_id'`],
      ["church.activation_payments", `SELECT count(*)::int FROM information_schema.tables WHERE table_schema='church' AND table_name='activation_payments'`],
      ["church.denominations", `SELECT count(*)::int FROM information_schema.tables WHERE table_schema='church' AND table_name='denominations'`],
      ["church.denomination_invites", `SELECT count(*)::int FROM information_schema.tables WHERE table_schema='church' AND table_name='denomination_invites'`],
      ["enum overseer", `SELECT count(*)::int FROM pg_enum WHERE enumlabel='overseer'`],
      ["fn my_login_context", `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='my_login_context'`],
      ["fn provision_church_v3", `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='provision_church_v3'`],
      ["fn activate_church_workspace_v2", `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='church' AND p.proname='activate_church_workspace_v2'`],
      ["fn overseer_denomination_totals", `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='church' AND p.proname='overseer_denomination_totals'`],
    ]

    let bad = 0
    for (const [label, sql] of checks) {
      const r = await pool.query(sql)
      const n = r.rows[0].count
      const ok = n >= 1
      if (!ok) bad++
      console.log(`  ${ok ? 'ok  ' : 'MISS'}  ${label} (= ${n})`)
    }

    // Verify the overseer enum value is usable on a profile upsert path.
    await pool.query(`INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(),'chk@e2e.test')`)
    const u = (await pool.query(`SELECT id FROM auth.users WHERE email='chk@e2e.test'`)).rows[0]
    await pool.query(`INSERT INTO public.admin_profiles (id, email, role) VALUES ($1,'chk@e2e.test','overseer')`, [u.id])
    console.log('  ok    insert admin_profiles with role=overseer')

    if (bad > 0) {
      console.error(`[check-db] ${bad} object(s) missing`)
      process.exitCode = 1
    } else {
      console.log('[check-db] all objects present ✔')
    }
  } catch (err) {
    console.error('[check-db] FAILED:', err)
    process.exitCode = 1
  } finally {
    await pool.end().catch(() => undefined)
    await pgInstance.stop().catch(() => undefined)
    rmSync(dbDir, { recursive: true, force: true })
  }
}

main()
