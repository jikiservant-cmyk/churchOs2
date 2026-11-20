# SMS economics — 50 cost, 70 retail, 5,000 a week

**Confirmed by the founder (17 Nov 2026): every message costs you 50 UGX.**
So the margin is **20**, not the 25 this file previously assumed. Every number below is recomputed.

| | |
|---|---|
| Your cost | **50 UGX per SMS** |
| Retail rate a church pays | **70 UGX per SMS** (`DEFAULT_SMS_RATE`, `lib/wallet-read.ts`, per-wallet `sms_rate`) |
| **Your margin** | **20 UGX per SMS = 28.6% of what the church spends** |
| Minimum top-up | 1,000 UGX (`lib/money.ts`) · Maximum 2,000,000 |

---

## 1. One church at 5,000 a week

| | |
|---|---|
| SMS bought | **71** (71 × 70 = 4,970; 30 left over) |
| Your margin | **1,420/week** |
| Per month (×52/12) | **6,153** |
| Per year | **73,840** |

**Break-even against the 17,000 activation: 12 weeks.** So the wallet overtakes the activation fee in
about three months, and by year one it has earned **4.3× the activation fee** from the same church.
That is still the argument — it is just a month slower than the old 25-margin arithmetic implied.

---

## 2. What 5,000 buys the church

5,000 = 71 messages = **one weekly message to 70 people**, no more.

| Church size | One weekly message to all | Cost/week | Your margin/week |
|---|---|---|---|
| 60 | 60 SMS | 4,200 | 1,200 |
| 100 | 100 SMS | 7,000 | 2,000 |
| 150 | 150 SMS | 10,500 | 3,000 |
| 400 | 400 SMS | 28,000 | 8,000 |

A 5,000-a-week church is a small church, or a big church sending rarely. The big churches that
actually message weekly are worth 5–6× that, and they cost you nothing extra to serve.

---

## 3. Scale at 5,000/week each

| Churches | Wallet inflow/week | SMS/week | Margin/week | Margin/month | Margin/year |
|---|---|---|---|---|---|
| 4 (Worship House) | 20,000 | 284 | 5,680 | 24,613 | 295,360 |
| 8 (fellowships) | 40,000 | 568 | 11,360 | 49,227 | 590,720 |
| 32 (TJM) | 160,000 | 2,272 | 45,440 | 196,907 | 2,362,880 |
| 67 (10% of Phaneroo) | 335,000 | 4,757 | 95,140 | 412,273 | 4,947,280 |
| 100 | 500,000 | 7,100 | 142,000 | 615,333 | 7,384,000 |
| **244** | 1,220,000 | 17,324 | 346,480 | **1,501,440** | 18,017,280 |
| 670 (all Phaneroo) | 3,350,000 | 47,570 | 951,400 | 4,122,667 | 49,472,000 |

**244 churches at 5,000/week to replace 1.5M a month.** That is next year, not Friday — the wallet is
the compounding line, the activation is the Friday line.

But TJM alone is **196,907 a month, forever, with no new sale**. That is the sentence to hold onto when
a pastor haggles over 17,000.

---

## 4. The lever you have not used: the rate, not the volume

Your margin per shilling a church spends is fixed by the rate:

| Retail rate | Margin/SMS | Margin as % of church spend | Per 5,000 spent |
|---|---|---|---|
| 60 | 10 | 16.7% | 833 |
| **70 (now)** | **20** | **28.6%** | **1,429** |
| 80 | 30 | 37.5% | 1,875 |
| 90 | 40 | 44.4% | 2,222 |
| 100 | 50 | 50.0% | 2,500 |

**28.6% is thin** for a business that also carries support, failed sends and refunds. Moving the rate
from 70 to 80 raises margin per shilling by **31%** at the same volume — and it is one number in
`wallets.sms_rate`, not a re-sale.

Before you move it: check what the other Kampala bulk-SMS resellers charge a church. If they are at
65–70, 80 is a hard sell; if they are at 90, you are already underpriced.

---

## 5. Three practical rules, unchanged

1. **Sell the month, not the week.** 20,000 for the month = 285 SMS = 5,700 margin, and one prompt on
   the handset instead of four. Weekly top-ups mean 52 prompts and 52 chances to run dry.
2. **Watch the empty wallet, not the top-up size.** The churn predictor is "balance dies before month
   end", not "topped up small".
3. **Never discount the rate.** At a cost of 50, a church on 60 leaves you 10 — a third of your margin,
   permanently, and that rate travels to every pastor in the district. Give **bonus messages**, never a
   cheaper message.

---

## 6. The one sentence

**5,000 a week = 71 messages for them, 1,420 for you, and it beats the activation fee in twelve weeks.**
