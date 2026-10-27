// Minimal PostgREST-compatible mock, just enough for the usher flow.
// Used only for local testing; not part of the app.
import http from 'node:http';
import crypto from 'node:crypto';

// Derive the stored passkey hash exactly as lib/attendance-actions.ts does, so
// MOCK_PASSKEY + USHER_JWT_SECRET can be used to log in against the mock.
// Nothing is hardcoded: with no env, no passkey can authenticate.
const DERIVED = process.env.USHER_JWT_SECRET
  ? crypto.createHmac('sha256', 'usher_jwt_domain_separation').update(process.env.USHER_JWT_SECRET).digest()
  : null;
const PASSKEY_HASH = DERIVED && process.env.MOCK_PASSKEY
  ? crypto.createHmac('sha256', DERIVED).update(process.env.MOCK_PASSKEY).digest('hex')
  : null;

const CHURCH = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Grace Community Church',
  slug: 'grace-church',
  passkey: null,
  passkey_hash: PASSKEY_HASH,
  passkey_version: 1,
  activation_status: 'active',
  theme_color: 'bg-slate-900',
  logo_url: null,
  sender_id: null,
};

const MODE = process.env.MOCK_MODE || 'ok'; // 'ok' | 'no-church'
// 'missing-columns' — the DB was built from this repo: passkey_hash /
//   passkey_version were never created, so PostgREST answers 42703.
// 'provisioned'     — provision_tenant set an unknowable random passkey_hash
//   while `passkey` still holds the readable 6-digit default.
// 'backfilled'      — the state after 011 + 012: the hash columns exist but
//   every hash is NULL, and `passkey` holds a 10-hex code from the backfill.
//   This is what production looks like now, and nothing had tested against it.
const SCENARIO = process.env.MOCK_SCENARIO || 'ok';

const log = (...a) => console.log('[mock]', ...a);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const profile = req.headers['accept-profile'] || 'public';
  const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');

  log(req.method, path, 'profile=' + profile, 'obj=' + wantsObject, url.search || '');

  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // ── PostgREST data API ────────────────────────────────────────────────
  if (path.startsWith('/rest/v1/')) {
    const table = path.slice('/rest/v1/'.length).split('/')[0];

    if (MODE === 'no-church') return send(200, wantsObject ? {} : []);

    if (table === 'churches') {
      if (SCENARIO === 'missing-columns') {
        const sel = url.searchParams.get('select') || '';
        for (const col of ['passkey_hash', 'passkey_version', 'passkey_updated_at']) {
          if (sel.includes(col)) {
            return send(400, {
              code: '42703',
              message: `column church.churches.${col} does not exist`,
              details: null,
              hint: null,
            });
          }
        }
      }
      if (SCENARIO === 'backfilled') {
        // 011 applied (columns exist, hashes empty) + 012 applied (10-hex code).
        const row = { ...CHURCH, passkey: 'A3E5397FAC', passkey_hash: null, passkey_version: 1,
                      passkey_updated_at: new Date().toISOString() };
        return wantsObject ? send(200, row) : send(200, [row]);
      }
      if (SCENARIO === 'provisioned') {
        // Hash of a value nobody knows, exactly like provision_tenant generates.
        const unknown = crypto.randomBytes(32).toString('hex');
        return wantsObject
          ? send(200, { ...CHURCH, passkey: '483920', passkey_hash: unknown, passkey_version: 1 })
          : send(200, [{ ...CHURCH, passkey: '483920', passkey_hash: unknown, passkey_version: 1 }]);
      }
      // Honour ?id=eq.<uuid> so the re-bind lookup behaves realistically.
      const idFilter = url.searchParams.get('id');
      const matches = !idFilter || idFilter === `eq.${CHURCH.id}`;
      if (!matches) {
        return wantsObject ? send(406, { message: 'No rows found' }) : send(200, []);
      }
      return wantsObject ? send(200, CHURCH) : send(200, [CHURCH]);
    }

    if (table === 'events') {
      if (process.env.MOCK_EVENT !== '1') return send(200, []);
      const ev = {
        id: '22222222-2222-4222-8222-222222222222',
        church_id: CHURCH.id,
        name: 'Sunday Celebration Service',
        service_type: 'sunday_service',
        event_date: new Date().toISOString().slice(0, 10),
        start_time: '09:00:00',
        status: 'active',
        attending_count: 0,
      };
      return wantsObject ? send(200, ev) : send(200, [ev]);
    }
    if (table === 'attendance_logs') return send(200, []);
    if (table === 'members') {
      return send(200, [
        { id: 'm1', full_name: 'Alice Namono', phone_number: '256772000001', gender: 'female', is_youth: false, status: 'active', church_id: CHURCH.id, created_at: '2026-01-02T00:00:00Z' },
        { id: 'm2', full_name: 'Brian Okello', phone_number: '256772000002', gender: 'male', is_youth: true, status: 'active', church_id: CHURCH.id, created_at: '2026-02-03T00:00:00Z' },
      ]);
    }

    // Anything else: empty result, never an error.
    return send(200, wantsObject ? {} : []);
  }

  // ── Supabase Auth (no session configured in this harness) ─────────────
  if (path.startsWith('/auth/v1/')) {
    return send(401, { error: 'invalid claim: missing sub claim', error_code: 'bad_jwt' });
  }

  send(404, { error: 'unhandled', path });
});

const PORT = Number(process.env.MOCK_PORT || 54321);
server.listen(PORT, '0.0.0.0', () => log(`listening on 0.0.0.0:${PORT} mode=${MODE}`));
