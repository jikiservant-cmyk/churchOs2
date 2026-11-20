# 4-Day Activation Sprint — Kampala Born-Again Networks

**Goal:** UGX 1,500,000 collected and settled.
**Unit:** activation = UGX 17,000 (`ACTIVATION_STANDARD_FEE_UGX`). SMS margin = UGX 25/SMS.
**Math:** 89 individual activations — OR ~2 diocese bundles + 15–20k SMS sent.

The whole game is **sell to the level that decides for many branches**, not to 89 pastors one by one.
This document lists who those people are, how to reach them, and what to say.

---

## ⚠️ Sell only what works

| Say this | Never say this |
|---|---|
| Members, attendance, usher check-in | "Online giving / MoMo collection" |
| SMS broadcasts (50 UGX/SMS, bulk) | "We collect church offerings" |
| Diocese dashboard, white-label branding | "Money comes into the app" |
| Invite codes for all your branches | "Donations are tracked" |

Reason: `lib/public-giving.ts` has `PUBLIC_GIVING_ENABLED = false`, the webhook only settles
`BUY_SMS`, and there is no `church.donations` table or payout path. If you sell giving and a
pastor discovers it shows "coming soon", you will be refunding 17,000s in a hall full of pastors.
**SMS + records + diocese oversight is a genuinely good product. Sell that.**

---

## Tier 1 — Umbrella bodies (one endorsement = thousands of churches)

### National Fellowship of Born Again Pentecostal Churches of Uganda (NFBPC-U)
The biggest born-again umbrella in Uganda — claims **50,000+ churches**, with a structure you can
sell straight into: 2,184 sub-county bishops → 202 district bishops → 60 provincial bishops →
15 regional bishops → 6 national bishops.
- **Archbishop's / GO's office:** Plot 38, Bible House, Bombo Road, Level 3, Kampala
- **Secretariat:** Balokole House, Kiwanga-Kasokoso, Mukono Municipality
- **Email:** nfbpc.secretariat@gmail.com · **Web:** https://nfbpc.org/
- **Leadership:** Abp. Dr. Moses Odongo (General Overseer), Bp. Dr. Africano Magyezi (General Secretary)
- Source: https://nfbpc.org/

**Pitch:** "Your 202 district bishops each oversee 10–30 churches. Give me one hour at a district
bishops' meeting and I'll register every branch before they leave the room. The secretariat gets
the national dashboard free."

### Born Again Faith (BAF)
The other national umbrella (Apostle Joseph Serwadda). Same play — endorsement + a room full of pastors.

---

## Tier 2 — Hierarchical networks with central control (one meeting, many branches)

### 🥇 Pentecostal Assemblies of God (PAG) Uganda — the single biggest prize
- **6,000–7,000 churches**, ~1.6–1.8M weekly attendance, present in **111 districts**
- Structured as **24 Pastorates / 515 Assemblies** — exactly the shape your denomination tier serves
- **HQ:** 14a Luthuli Avenue, Kampala · https://paguganda.org/about-pag-uganda/
- Their **annual convention** puts thousands of pastors in one place — one table at the door
  outperforms a month of meetings.

### 🥈 United Apostolic Church of Uganda — best size-to-effort ratio
- **654 established churches**, 50,000+ members, across **103 districts**
- https://unitedapostolicchurchug.org/
- 654 branches × 17,000 = 11M of headroom; closing even **5% = 33 churches = 561,000**
- One national office decision, not 654 conversations.

### 🥉 Miracle Centre Cathedral (Ps. Robert Kayanja)
- Claims range from **1,000 to 5,000 branches** depending on the source — treat the low number as
  the honest one and ask them to confirm
- HQ: Miracle Centre, Mengo, Kampala
- Sources: https://sunrise.ug/faith/202507/spiritual-renewal-sweeps-uganda-as-bishop-benny-hinn-leads-crusades-meets-president-museveni

### Watoto Church — smallest count, easiest close
- **17–18 campuses** in Uganda + Juba, ~30,000 weekly attendance
- Highly centralized (same sermon, rotating teams) → **one IT/ops decision covers every campus**
- HQ Kampala · leadership: Ps. Julius & Vernita Rwotlonyo
- Source: https://flashugnews.com/exploring-the-history-and-mission-of-watoto-church-in-uganda/

### RCCG Uganda (Redeemed Christian Church of God)
- Global hierarchy is **Parish → Area → Zone → Province → Region** — one province covers many parishes
- Global HQ Lagos, but Uganda runs on provincial pastors: find the **Uganda provincial pastor**, not a single parish.
- Reference: https://grokipedia.com/page/Redeemed_Christian_Church_of_God

### Christ Embassy / LoveWorld Uganda
- Reachable via the national office; assemblies across Kampala (e.g. City Center on Kampala Road,
  Mutungo). Contact route: https://ceugonline.org
- Note: their global structure is tight — expect a longer chain, lower priority this week.

### Winners Chapel Kampala (Living Faith Church)
- Rubaga Road, next to Hotel Sojovalo · **+256 700 125208** · wmakampala@yahoo.com
- Useful as a door into the wider Winners network.

---

## Tier 3 — The close-fast sweet spot (20–100 branches, decision in one meeting)

Bigger than a single congregation, small enough that the leader can say yes on the spot:

- **Deliverance Church Uganda** — old network, many assemblies nationwide
- **Omega International Ministries** — Namasuba/Zzana, Entebbe Road
- **Liberty Worship Centre International** (Ps. Imelda Namutebi) — Lugala
- **House of Prayer Ministries International** (Ps. Aloysius Bugingo) — huge congregation + media reach
- **Kasanga Miracle Centre**, **Christian Life Church** (Bwaise), **Calvary Chapel Kampala**
- **District bishoprics of NFBPC/PAG** — a district bishop with 20 churches is your ideal customer
- Directory to mine: https://bawdigital.com/list-of-churches-in-kampala-by-baw-digital/

---

## Channels that skip the church-by-church grind

1. **Conventions & AGMs** — PAG annual convention, NFBPC AGM, diocesan synods. One table, hundreds of pastors.
2. **Bible colleges / seminaries** — pastors in training plant branches; teach the app once, they activate as they plant.
3. **District bishops' meetings** — 202 districts × 10–30 churches. **5 meetings ≈ 50–150 churches.**
4. **Kampala pastors' fellowships** — they meet monthly; get on the agenda.
5. **Gospel radio pastor shows** — Power FM, Spirit FM, Family Radio. Offer a free training session on air.
6. **Church suppliers** — sound/PA, tents, chairs, uniforms, printing. They visit 20 churches a week;
   pay **2,000 UGX referral per activated branch** (they'll sell harder than you will).
7. **Campus fellowships** — FOCUS, Scripture Union, campus ministries: young leaders who plant churches.

---

## Deal structures that close in one meeting

| Bundle | Price | Your sweetener | Your cost |
|---|---|---|---|
| Single branch | 17,000 | — | — |
| 20 branches | 340,000 | 20 free SMS each | 10,000 |
| 30 branches | 510,000 | 1,000 free SMS + diocese dashboard | 25,000 |
| 50+ branches | 850,000 | White-label logo/colours + priority support | ~0 (already built) |

Rules:
- **Never discount the single 17,000.** Discount only in volume, and only as free SMS credits —
  it costs you 25/SMS and is worth 50/SMS to them. Best-value concession you have.
- The **diocese dashboard is your demo** — it's already built and it's what a bishop actually wants.
- Collect **at least 50% on the spot**, in the meeting, with the pastor/overseer approving the
  MoMo prompt while you're sitting there (see the 5-minute window warning below).

---

## The one code gap that will hurt you

There is **no bulk/manual activation** in the app. `activation_status` is only ever set by the
Na'jiki settlement RPC; there is no super-admin screen. So a 30-branch invoice means either:
- 30 separate MoMo prompts, each expiring in **5 minutes** (`ACTIVATION_PROMPT_WINDOW_DEFAULT_MS`), or
- you hand-editing 30 rows in Supabase — and then you have **no `activation_payments` ledger entries**,
  which is your only revenue record.

**Recommended build (2–4 hours):** a "Bulk activation" admin page — pick a diocese, enter the amount
received, and it writes `activation_payments` rows + flips `activation_status` per church in one
transaction, with an audit note. That single screen is what makes diocese deals operationally possible.

---

## 4-day schedule

**Day 0 — today (before you sell anything)**
1. **Prove the money chain end to end with real money** (20 minutes, see below). Na'jiki settles
   instantly to the account, so the only remaining risk is that our activation path itself is broken.
2. Fix the `/overseer` error card (see `docs/DENOMINATIONS.md`, known issue #1) so the demo doesn't break.
3. Call NFBPC secretariat, PAG HQ, United Apostolic. Book 3 meetings for Tue/Wed.

### The UGX 1,000 end-to-end test (do this before your first meeting)

`ACTIVATION_FEE_UGX` exists precisely for this. In Vercel, set `ACTIVATION_FEE_UGX=1000`, redeploy,
then activate a test church with your own phone and confirm all five links:

1. MoMo prompt arrives and you approve it inside the **5-minute** window
2. Na'jiki fires the signed webhook at `/api/najiki/webhook`
3. `church.activation_payments` gets a settled row with `amount = 1000`
4. `church.churches.activation_status` flips to `active` and the admin area unlocks
5. **UGX 1,000 actually lands in your settlement account**

Then **delete `ACTIVATION_FEE_UGX`** and redeploy — the app logs a loud warning while test pricing is
live, and forgetting this means you sell activations at 1,000 instead of 17,000.

If any of the five links fails, fix it today. Discovering a broken settlement in front of a bishop —
with 30 pastors watching — ends the deal and the relationship.

**Day 1 (Tue)** — 3 meetings. Demo the diocese dashboard on your laptop. Ask for a district bishops' slot.
**Day 2 (Wed)** — district bishops' meeting / convention table. Register branches on the spot; prompts approved live.
**Day 3 (Thu)** — close the remainder, chase SMS top-ups from every church already onboard (pure margin, no new sales).
**Day 4 (Fri)** — settlement must already be in your account. Cash buffer day only.

---

## Landmines (in priority order)

1. **Activation path integrity.** Settlement is instant, so the risk moved: the five-link test above is now
   the single most important thing you do today. A broken webhook means money taken and no church activated.
2. **5-minute prompt window.** Prompt expires fast — never send prompts and walk away. Be in the room.
3. **`/overseer` incomplete-response error card** — kills diocese demos in 10 seconds. Fix before Tuesday.
4. **Don't oversell giving.** It's disabled and unbuilt. Say "coming soon" if asked, nothing more.
5. **Don't take money you can't deliver on.** If a diocese pays for 30 branches, all 30 must be live
   the same day. Refund on the spot if anything fails — one burned bishop closes a whole network to you.
