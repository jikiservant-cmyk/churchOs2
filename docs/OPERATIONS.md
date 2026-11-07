# churchOs Operations Runbook

How the production system runs as of 7 November 2026. Project:
`vzvtirgkjvhnnqwmpsbj`. All schedules are pg_cron (Supabase) — **no Vercel
crons** (free plan).

## Nightly schedule (pg_cron)

| Job name | UTC | Kampala | What it does |
| --- | --- | --- | --- |
| `refresh-inactive-30-days-daily` | 02:00 | 05:00 | Flags members with no present/late check-in in 30 days (`inactive_30_days`) |
| `process-inactive-30-days-followups-daily` | 02:10 | 05:10 | Follow-up lifecycle for those flags (resolve/reopen/notes) |
| `refresh-consecutive-event-flags-daily` | 02:20 | 05:20 | Streak engine: flags `missed_consecutive_events` (threshold per church, default 3) |
| `auto-complete-stale-events-hourly` | :55 every hour | :55 | Auto-closes forgotten open events so stuck events can't hide misses |
| `birthday-sms-daily-0600utc` | 06:00 | **09:00** | Enqueues + dispatches birthday SMS for opted-in churches |

All five run headless-safe (functions tolerate `auth.uid() IS NULL`). The
streak engine is additionally triggered instantly when an event is marked
completed (`lib/attendance-actions.ts::updateEventStatus`, scoped to the
members expected at that event) and by the "Scan Inactivity" button.

Check health any time:

```sql
SELECT jd.jobid, j.jobname, jd.status, jd.start_time, jd.return_message
FROM cron.job_run_details jd JOIN cron.job j USING (jobid)
ORDER BY jd.start_time DESC LIMIT 20;
```

History note: before the 2026-11-06 repair the nightly jobs failed every night
with `Tenant access denied` (tenant-auth-gated function bodies). Migration
`026_live_alignment.sql` carries the fix; run it on any database built before
that date.

## SMS delivery window (critical billing fact)

The shared sender `AFRICASTKNG` is **rejected by the operator roughly between
20:00 and 08:00 Kampala** (verified live: 03:37 and 03:46 sends failed at
Africa's Talking and were still charged; 08:55 delivered; May 2026 volume
analysis showed time-of-day is the only failure predictor).

- Birthday job deliberately runs at **09:00 Kampala** — one hour inside the
  proven-safe window.
- Do **not** schedule evening broadcasts until an alphanumeric sender ID is
  registered (Africa's Talking dashboard → Alphanumerics). After registration
  the night filter should no longer apply.

## SMS pipeline & billing chain

```
pg_cron / app action
  → church.sms_queue (pending, idempotency_key)
  → POST {sms_id} → Edge Function church-najiki-dispatch   (verify_jwt=false,
     guarded by x-dispatch-secret from vault secret church_dispatch_secret_birthday)
  → RPC claim_sms_queue_item → RPC reserve_sms_queue_debit
     (idempotent per smsq_debit_<sms_id>) → public.debit_sms_wallet
  → Africa's Talking send → complete/fail/release RPCs
```

Wallet is per tenant in `public.wallets` (tenant_id = church id as text).
Dispatch costs UGX 25 at the operator; the wallet debits UGX 50 (Na'jiki
markup). AT charges on submission; **failed sends are not refunded** until DLR
wiring adds refund-on-failure (proposed, not built).

Delivery receipts: `church.sms_queue.delivery_status` stays NULL today — AT's
callback is not yet pointed through Na'jiki. The receiving Edge Function
(`najiki-webhook`, verify_jwt=false) is deployed and ACTIVE; wiring = set the
callback URL in the AT dashboard to route into it.

## Birthday automation

- Per-church toggle: Settings → Birthday Wishes (pastor-only) →
  `church.birthday_automation.enabled`, default **OFF**.
- Birthdays are stored **month/day only** (placeholder year 2000; never
  displayed or sent). Feb-29 celebrants are handled on Feb-28 of non-leap
  years (`lib/birthday.ts`).
- Template cap 320 chars; `{name}` and `{church}` placeholders.
- Idempotency key `bday:<member_id>:<year>` — one send per member per year.
  Manual re-sends need a distinct key suffix (e.g. `:resend1`).
- Dry run: `SELECT church.enqueue_daily_birthdays(true);`

## Attendance flagging (summary)

Rule: a member is flagged after missing the last **N** (default 3,
`churches.attendance_flag_threshold`) consecutive completed events they were
**expected** at — expectation = event weekday ∈ `churches.meeting_days` ∩
`members.expected_days` (NULLs = all). `present`/`late`/`excused` break a
streak; events before join date don't count; inactive members are skipped.
Flags open, reopen, auto-resolve on return, and never overwrite
`followed_up` while the streak is high. Full spec:
`ATTENDANCE_FLAGS.md` + `lib/attendance-streaks.ts`.

## Known debts / follow-ups

1. **Wallet fuel**: check `public.wallets` before enabling automations at
   volume (sdfg balance was 200 = ~4 messages on 7 Nov).
2. **Sender ID registration** (AT dashboard) — removes the night filter.
3. **DLR callback wiring** — fills `delivery_status`; enables failed-delivery
   refunds later.
4. **Repo alignment**: `migrations/025` still contains the unaliased `i.id`
   bug (fixed forward in `026`); `provision_church_v2/v3` and
   `sync_missed_3_sundays_flags` (deprecated, safe to delete) live only in the
   production DB; the ghost super_admin profile (`261d9539…`, no auth user)
   should be deleted.
5. **Denomination layer**: see `docs/DENOMINATIONS.md` (incl. its known issue).
