# SMS economics — what 5,000 UGX a week per church actually is

**The numbers in code**

| | |
|---|---|
| Retail rate a church pays | **70 UGX per SMS** (`DEFAULT_SMS_RATE` in `lib/wallet-read.ts`, per-wallet `sms_rate`) |
| Documented margin | **25 UGX per SMS** (`docs/ACTIVATION_SPRINT_KAMPALA.md`) → implied cost ~45 |
| Minimum top-up | **1,000 UGX** (`lib/money.ts`) |
| Maximum top-up | 2,000,000 UGX |

⚠️ The 70 is in the code. The **25 is from the plan, not the code** — the code has no cost field.
Confirm the real Africa's Talking price on the invoice; if they charge 55, the margin is 15, not 25.

---

## 1. One church at 5,000 a week

| | |
|---|---|
| SMS bought | **71** (71 × 70 = 4,970, 30 left over) |
| Your margin | **1,775/week** |
| Per month (×52/12) | **7,692** |
| Per year | **92,300** |

**The number that matters:** the activation fee is 17,000 once. At 5,000/week the SMS margin
overtakes it in **9.6 weeks** — about two and a half months. From month three, every shilling on that
church is recurring, and by year one the SMS line has earned **5.4× the activation fee** from the same
customer.

That is the whole argument for the SMS line: the activation buys the customer, the wallet pays for
the customer.

---

## 2. What 5,000 a week means to the church

5,000 buys 71 messages. So **5,000 a week ≈ one message a week to 70 people**, and no more. Against
real congregation sizes:

| Church size | One weekly message to everyone | Cost/week | Cost/year | Your margin/week | Margin/year |
|---|---|---|---|---|---|
| 60 | 60 SMS | 4,200 | 218,400 | 1,500 | 78,000 |
| 100 | 100 SMS | 7,000 | 364,000 | 2,500 | 130,000 |
| 150 | 150 SMS | 10,500 | 546,000 | 3,750 | 195,000 |
| 400 | 400 SMS | 28,000 | 1,456,000 | 10,000 | 520,000 |

Two consequences:

1. **A 5,000-a-week church is a small church, or a large church sending rarely.** Set the expectation
   at that level and nobody is disappointed.
2. **The big churches self-select upward.** A 400-member church that actually messages weekly is worth
   **28,000 a week** to the wallet and 10,000 to you. That is where the SMS business is, and it is why
   the large congregation matters more than the branch count.

---

## 3. Scale — at 5,000/week each

| Churches | Wallet inflow/week | SMS/week | Margin/week | Margin/month | Margin/year |
|---|---|---|---|---|---|
| 4 (Worship House) | 20,000 | 284 | 7,100 | 30,767 | 369,200 |
| 8 (fellowships) | 40,000 | 568 | 14,200 | 61,533 | 738,400 |
| 32 (TJM) | 160,000 | 2,272 | 56,800 | 246,133 | 2,953,600 |
| 67 (10% of Phaneroo) | 335,000 | 4,757 | 118,925 | 515,342 | 6,184,100 |
| 100 | 500,000 | 7,100 | 177,500 | 769,167 | 9,230,000 |
| **195** | 975,000 | 13,845 | 346,125 | **1,499,875** | 17,998,500 |
| 670 (all Phaneroo) | 3,350,000 | 47,570 | 1,189,250 | 5,153,417 | 61,841,000 |

**Read the bottom line of the middle:** it takes **195 churches at 5,000/week to replace 1.5M a
month**. That is not next week — that is next year's business. Which is exactly why the SMS margin is
the compounding line and the activation is the Friday line. Do not confuse the two.

But note what TJM alone does: **32 branches = 246,133 a month, every month, for nothing** — no new
sale, no new visit, no fare. That is the argument to make to yourself when a pastor haggles over
17,000.

---

## 4. Three practical adjustments

**Sell it monthly, not weekly.** 5,000 × 52 is 52 mobile-money transactions and 52 chances for the
wallet to run dry mid-month. Offer **20,000 for the month** instead — 285 SMS, margin 7,125, and one
prompt on the handset instead of four. Same money, a quarter of the friction.

**Watch the actual send rate, not the top-up rate.** A church that tops up 5,000 and sends 200 SMS
moves the money through in 18 days. The metric that predicts churn is *wallet empty before month
end*, not top-up size.

**Don't discount the rate to win the bundle.** `sms_rate` is per-wallet, so you *can* drop a church to
60/SMS — and at a 45 cost that leaves 15. Margin halves while the support burden stays the same. If a
church needs cheaper messages, give it **more messages at the same rate** (a bonus balance), never a
lower rate: a rate is permanent and travels.

---

## 5. The one number to remember

**5,000 a week = 1,775 to you, 71 messages to them, and in ten weeks it has beaten the activation fee.**

Everything else on this page is that sentence multiplied.
