# SMS economics — buy 25, sell 50

**Founder's model (17 Nov 2026): buy at 25, sell at 50. Margin 25 — half of what the church spends.**

| | |
|---|---|
| Your cost | **25 UGX per SMS** |
| Retail rate a church pays | **50 UGX per SMS** |
| **Margin** | **25 UGX = 50% of the church's spend** |
| Minimum top-up | 1,000 UGX (`lib/money.ts`) · Maximum 2,000,000 |

**What the database says, and what the code said.** The live wallets carry `sms_rate = 50`, so churches
are already being charged 50 — that was always the effective price. The *fallback* in
`lib/wallet-read.ts` (`DEFAULT_SMS_RATE`) was 70, and it is used only when a wallet row is missing, has
`sms_rate` null, or the column does not exist; both wallet-creation paths in `lib/wallet-actions.ts`
also wrote 70. That fallback is now **50**, so the code and the database finally agree. No church's
price changed by this — the rows already said 50.

> **Optional audit — nothing is broken.** The rate is stored per wallet, and yours are already 50. Run
> this only to confirm there is no stray row (null, 0, or an old 70) that would be quoted differently:
>
> ```sql
> select tenant_id, sms_rate, balance
> from public.wallets
> where sms_rate is distinct from 50
> order by tenant_id;
> ```
>
> If that list is churches you have already been billing at 70, decide deliberately: leave them
> (they agreed to 70) or move them to 50 with a note. Do not mass-update silently.

---

## 1. One church at 5,000 a week

| | |
|---|---|
| SMS bought | **100** (100 × 50 = exactly 5,000) |
| Your margin | **2,500/week** |
| Per month (×52/12) | **10,833** |
| Per year | **130,000** |

**Break-even against the 17,000 activation: 6.8 weeks.** Under seven weeks and the wallet has paid back
the activation fee; by year one it has earned **7.6× the activation fee** from the same church, with no
second sale.

That is why 50 is a better price than 70 for you, not just for them: at 70 a church gets 71 messages for
its 5,000 and feels the cost; at 50 it gets 100 and stops thinking about it. Same money in, half the
friction out.

---

## 2. What 5,000 buys the church

| Church size | One weekly message to all | Cost/week | Your margin/week |
|---|---|---|---|
| 60 | 60 SMS | 3,000 | 1,500 |
| 100 | 100 SMS | 5,000 | 2,500 |
| 150 | 150 SMS | 7,500 | 3,750 |
| 400 | 400 SMS | 20,000 | 10,000 |

**5,000 a week = one message a week to 100 people.** That is a real congregation, not a token, and it is
the sentence to use in the room: *"five thousand a week and you can message everyone in your church
once a week, every week."*

---

## 3. Scale at 5,000/week each

| Churches | Wallet inflow/week | SMS/week | Margin/week | Margin/month | Margin/year |
|---|---|---|---|---|---|
| 4 (Worship House) | 20,000 | 400 | 10,000 | 43,333 | 520,000 |
| 8 (fellowships) | 40,000 | 800 | 20,000 | 86,667 | 1,040,000 |
| 32 (TJM) | 160,000 | 1,600 | 80,000 | **346,667** | 4,160,000 |
| 67 (10% of Phaneroo) | 335,000 | 3,350 | 167,500 | 725,833 | 8,710,000 |
| 100 | 500,000 | 5,000 | 250,000 | 1,083,333 | 13,000,000 |
| **139** | 695,000 | 6,950 | 347,500 | **1,505,833** | 18,070,000 |
| 670 (all Phaneroo) | 3,350,000 | 33,500 | 1,675,000 | 7,258,333 | 87,100,000 |

**139 churches at 5,000/week replaces 1.5M a month** — down from 244 at the old numbers, because the
margin per shilling doubled. TJM alone is **346,667 a month, recurring, with no new sale.**

---

## 4. Don't cut the rate — it is the whole margin

At a 25 cost:

| Retail rate | Margin/SMS | Margin as % of church spend | Per 5,000 spent |
|---|---|---|---|
| 40 | 15 | 37.5% | 1,875 |
| **50 (now)** | **25** | **50.0%** | **2,500** |
| 60 | 35 | 58.3% | 2,917 |
| 70 (what the code used to charge) | 45 | 64.3% | 3,214 |

A "small discount to 40" costs you **40% of the margin, permanently**, on every message that church will
ever send. Give **bonus messages** instead — a one-off balance credit leaves the rate intact.

The reverse is also true: 70 was not a ripoff, it was 64%. But 50 buys something 70 cannot — a church
that messages weekly instead of monthly, and a referral without an argument.

---

## 5. Three rules

1. **Sell the month, not the week.** 20,000 for the month = 400 SMS = 10,000 margin, and one handset
   prompt instead of four.
2. **Watch the empty wallet, not the top-up size.** At 50, a church of 500 that messages weekly burns 25,000 a
   week, so a 20,000 top-up is gone in under a month. Churn is predicted by the
   balance dying before month end, not by the top-up amount.
3. **Never discount the rate.** Bonus messages, never a cheaper message.

---

## 6. The one sentence

**Buy 25, sell 50: 5,000 a week is 100 messages for them, 2,500 for you, and the wallet has repaid the
activation fee in seven weeks.**
