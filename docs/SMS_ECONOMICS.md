# SMS economics — 25 margin, 70 retail, 5,000 a week

**Founder's figure (17 Nov 2026): the margin is 25 UGX per message.**
At a 70 retail rate that implies a cost of **45**.

> ⚠️ One inconsistency to settle: a 50 cost was also stated the same day. If **50** is the real
> Africa's Talking price, the margin is **20**, and every number on this page drops by 20%
> (1,420/week, 6,153/month, 244 churches for 1.5M). Check the invoice once and pick one.

| | |
|---|---|
| Retail rate a church pays | **70 UGX per SMS** (`DEFAULT_SMS_RATE`, `lib/wallet-read.ts`, per-wallet `sms_rate`) |
| **Your margin** | **25 UGX per SMS = 35.7% of what the church spends** (implied cost 45) |
| Minimum top-up | 1,000 UGX (`lib/money.ts`) · Maximum 2,000,000 |

---

## 1. One church at 5,000 a week

| | |
|---|---|
| SMS bought | **71** (71 × 70 = 4,970; 30 left over) |
| Your margin | **1,775/week** |
| Per month (×52/12) | **7,692** |
| Per year | **92,300** |

**Break-even against the 17,000 activation: 9.6 weeks.** The wallet overtakes the activation fee in
about two and a half months, and by year one it has earned **5.4× the activation fee** from the same
church, at no extra cost to serve.

---

## 2. What 5,000 buys the church

5,000 = 71 messages = **one weekly message to 70 people**, no more.

| Church size | One weekly message to all | Cost/week | Your margin/week |
|---|---|---|---|
| 60 | 60 SMS | 4,200 | 1,500 |
| 100 | 100 SMS | 7,000 | 2,500 |
| 150 | 150 SMS | 10,500 | 3,750 |
| 400 | 400 SMS | 28,000 | 10,000 |

A 5,000-a-week church is a small church, or a big church sending rarely. The big churches that
actually message weekly are worth 5–6× that, and they cost you nothing extra to serve.

---

## 3. Scale at 5,000/week each

| Churches | Wallet inflow/week | SMS/week | Margin/week | Margin/month | Margin/year |
|---|---|---|---|---|---|
| 4 (Worship House) | 20,000 | 284 | 7,100 | 30,767 | 369,200 |
| 8 (fellowships) | 40,000 | 568 | 14,200 | 61,533 | 738,400 |
| 32 (TJM) | 160,000 | 2,272 | 56,800 | 246,133 | 2,953,600 |
| 67 (10% of Phaneroo) | 335,000 | 4,757 | 118,925 | 515,342 | 6,184,100 |
| 100 | 500,000 | 7,100 | 177,500 | 769,167 | 9,230,000 |
| **195** | 975,000 | 13,845 | 346,125 | **1,499,875** | 17,998,500 |
| 670 (all Phaneroo) | 3,350,000 | 47,570 | 1,189,250 | 5,153,417 | 61,841,000 |

**195 churches at 5,000/week to replace 1.5M a month.** That is next year, not Friday — the wallet is
the compounding line, the activation is the Friday line.

But TJM alone is **246,133 a month, forever, with no new sale**. That is the sentence to hold onto when
a pastor haggles over 17,000.

---

## 4. The lever you have not used: the rate, not the volume

Your margin per shilling a church spends is fixed by the rate:

| Retail rate | Margin/SMS | Margin as % of church spend | Per 5,000 spent |
|---|---|---|---|
| 60 | 15 | 25.0% | 1,250 |
| **70 (now)** | **25** | **35.7%** | **1,786** |
| 80 | 35 | 43.8% | 2,188 |
| 90 | 45 | 50.0% | 2,500 |

**35.7% is workable but not generous** — it carries support, failed sends and refunds. Moving the rate
from 70 to 80 raises margin per shilling by **22%** at the same volume, and it is one number in
`wallets.sms_rate`, not a re-sale.

Before you move it: check what the other Kampala bulk-SMS resellers charge a church. If they are at
65–70, 80 is a hard sell; if they are at 90, you are already underpriced.

---

## 5. Three practical rules, unchanged

1. **Sell the month, not the week.** 20,000 for the month = 285 SMS = 7,125 margin, and one prompt on
   the handset instead of four. Weekly top-ups mean 52 prompts and 52 chances to run dry.
2. **Watch the empty wallet, not the top-up size.** The churn predictor is "balance dies before month
   end", not "topped up small".
3. **Never discount the rate.** On a 45 cost, a church at 60 leaves you 15 — 40% of your margin, gone
   permanently, and that rate travels to every pastor in the district. Give **bonus messages**, never a
   cheaper message.

---

## 6. The one sentence

**5,000 a week = 71 messages for them, 1,775 for you, and it beats the activation fee in ten weeks.**
