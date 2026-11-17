# COPE — partnership package

**Target:** COPE Ministries Uganda (Confederation of Pentecostal and Evangelical Ministries)
**Why first:** it is the only born-again body in Uganda with a **Ministry of Youth** written into its structure.
**Goal of the first conversation:** 15 minutes at Ndeeba, then a 5-church pilot.

Everything below is ready to send or say. Files: this brief + `docs/ChurchOS_COPE_Proposal.pdf`.

---

## What we know about them (say these facts back to them — it earns respect)

| Fact | Detail |
|---|---|
| Registered | With URSB; launched publicly in 2023 |
| Origin | Formed largely by churches that left NFBPC after the disputed March 2023 general-overseer election — reported at ~700 churches |
| National General Overseer | **Bp. Michael David Kyazze** — also leads Omega Healing Ministries, Namasuba · ngo@copeuganda.org |
| Prime Minister | **Mr. Rwegaba Dick** · pm@copeuganda.org |
| Secretary General | **Mr. Kizito Joseph** · sg@copeuganda.org |
| Phone / email | **+256 200 903 450** · info@copeuganda.org |
| Office | Plot 348, Ssemakokilo Road, Ndeeba, Kampala |
| Structure | Seven ministries, **including a Ministry of Youth**, a Ministry of Communication (Media), Education & Sports, Diaspora, Industry & Commerce, Health, Protocol & Security |

**The strategic read:** COPE is young, it needs to *prove value to its members* so they don't drift back, and
it has a youth ministry that currently has no tools. You are not asking them for a favour — you are handing
them something they can announce.

---

## The offer (three things, none of which cost COPE money)

**1. Free platform for member churches**
Member churches get the system free for the pilot: member records, CSV import from existing paper
registers, attendance, usher check-in with a passkey, SMS to members at 50/= per message, new-converts and
visitor tracking, and reports the pastor can actually use.

**2. A COPE national dashboard**
The national office sees its member churches in one view — churches, members, attendance, activity — without
asking 700 pastors for reports. This is the thing that makes COPE *look* like the organised body it wants to
be. It is already built (the multi-branch overseer dashboard).

**3. A COPE Youth Desk programme**
"COPE Founding Youth Leaders" — a 2-hour training per intake for youth leaders from member churches, a
certificate from COPE, and a WhatsApp network. Trained youth leaders implement the system in their own
churches. COPE gets a visible youth programme; churchOs gets implementers.

---

## What we ask in return (exactly four things)

1. **An endorsement letter** on COPE letterhead, naming churchOs as a recommended tool for member churches.
2. **A slot at the next COPE gathering** — 10 minutes, or a table at the door.
3. **Introductions to 20–30 member churches** for the pilot (starting with 5).
4. **Permission to name COPE as a partner** on our materials.

That's it. No money from COPE, no exclusivity, no cost to any pastor for the pilot.

---

## On money — the honest structure

- **COPE pays nothing.** Ever. Not for the platform, not for the dashboard, not for the training.
- **Member churches pay 17,000 UGX once** when they activate after the pilot. That is churchOs revenue, not
  a COPE fee, and it is stated plainly to every pastor.
- If COPE wants its youth programme funded, we propose a documented **"COPE Youth Fund"**: a fixed
  contribution per activated church (e.g. 3,000) paid to COPE's youth programme, invoiced monthly, in
  writing. **Never cash to an individual.** Say this out loud in the meeting — it protects both sides from
  any suggestion of inducement.

---

## What NOT to promise

| Don't say | Because |
|---|---|
| "It collects offerings / MoMo giving" | Public giving is disabled in this build (`PUBLIC_GIVING_ENABLED = false`) and no donation settlement path exists. Say **"coming later this year"** |
| "We have 50 churches already" | Do not inflate. Pastors in one network talk to each other |
| "It works offline fully" | Do not claim what you haven't tested on their phones |
| "Free forever" | Say **free for the pilot**, then 17,000 once. Clear beats generous |

---

## The first call — script

**Number:** +256 200 903 450 (if no answer: WhatsApp the same number, then email sg@ + pm@ + info@)

> "Good morning. My name is [name], I'm a Ugandan software developer here in Kampala. I've built a church
> records system — members, attendance, SMS — and I'm offering it free to COPE member churches as a pilot,
> with a national dashboard for your office.
>
> I'd like 15 minutes with whoever heads the **Ministry of Youth**, or with the **Ministry of
> Communication**. Who would that be, and when are they in Ndeeba?"

**If they ask "what's the catch?":**
> "No catch and no cost to COPE. Member churches pay 17,000 once if they choose to continue after the pilot.
> What I'd like from COPE is an endorsement, a slot at your next gathering, and introductions to a few
> member churches."

**If they ask "who else uses it?":**
> "You'd be among the first networks. That's why the pilot is free and why I'm coming in person rather than
> emailing a brochure."

---

## The 30-day plan you propose in the meeting

| Week | What happens | Who |
|---|---|---|
| 1 | 5 pilot churches onboarded — paper registers imported, ushers trained | churchOs + COPE Ministry of Youth |
| 2 | First youth-leader training (2 hours, 20–30 leaders) | churchOs runs it, COPE hosts and certifies |
| 3 | COPE national dashboard live for the office | churchOs |
| 4 | Review with COPE: what worked, what to fix, rollout decision | Both |

---

## The email (send after the call, same evening)

**Subject:** COPE × churchOs — free church records + SMS for member churches (15 min)

> Dear Bishop Kyazze / Mr. Kizito,
>
> I'm a Ugandan developer based in Kampala. I've built a church records platform — member registers,
> attendance, usher check-in and SMS to members at 50/= — and I would like to offer it free to COPE member
> churches as a pilot, with a national dashboard for your office so you can see member churches in one view.
>
> There is no cost to COPE. Member churches pay UGX 17,000 once only if they choose to continue after the
> pilot. In return I'd ask for an endorsement letter, a slot at your next gathering, and introductions to
> 20–30 member churches to start with five.
>
> May I have 15 minutes with the Ministry of Youth or the Ministry of Communication? I'm happy to come to
> Ndeeba at whatever time suits.
>
> [Name] · [phone] · churchOs, Kampala
>
> *Note: online giving/offerings collection is not part of this build — it is coming later this year. The
> pilot covers records, attendance and SMS only.*

That last line matters. It costs you nothing and it stops the one misunderstanding that would end the
relationship in week three.

---

## WhatsApp opener (shorter, if the phone isn't answered)

> "Good morning, my name is [name], Kampala developer. I've built a church records + SMS system and I'm
> offering it free to COPE member churches as a pilot, plus a national dashboard for your office. No cost to
> COPE. Who heads the Ministry of Youth, please? I'd like 15 minutes at Ndeeba."

---

## After they say yes — what you must have ready

1. **Denomination + invite code pre-created** in the database (this is SQL-side today — see
   `docs/DENOMINATIONS.md` known issue #2). Never mint codes in front of them.
2. **A demo church with 300+ members loaded** so the dashboard isn't empty when you open it.
3. **A printed one-pager** for each person in the room (`docs/ChurchOS_COPE_Proposal.pdf`).
4. **Your MoMo details** and the ability to activate a church live, in the room, with instant settlement.
5. **A blank pilot agreement** — 5 churches, 30 days, free, either side can stop.
