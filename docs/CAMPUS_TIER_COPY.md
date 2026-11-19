# Campus words — what to say, and what the screen now says

**The problem this fixes.** The activation screen had one label for any non-standard amount:

> *"Test pricing is active on this deployment: you will be charged UGX 9,500 instead of the standard
> UGX 17,000."*

Shown to a fellowship, that sentence tells the room three things you never want it to know: the price
is a **test**, the price is **negotiable**, and there is a **higher price** other people pay.

So the line now reads as a tier, not a test. It lives in the activation screen itself, takes the
amount from the server, and names no other price.

---

## 1. On the screen — what a fellowship sees

**Plan card**

> **Campus fellowship**
> UGX 9,500
> One-time fellowship activation

**Under the price, in a green panel**

> Campus fellowship rate — UGX 9,500, once. Not per term, not per member. If your fellowship sits
> under a church or a ministry, they are billed for the branch instead of you — say so and we will
> switch it.

**Why each part is there**

| The words | The job they do |
|---|---|
| "Campus fellowship" | Names a tier, so the number is a price, not a favour |
| "once" / "not per term, not per member" | Kills the subscription fear and the per-head fear in one line |
| "under a church or a ministry … billed for the branch instead of you" | Gives the honest reason the price is lower, **and** hands you the buyer above them |
| "say so and we will switch it" | Turns the screen into a question you want answered — the chaplaincy and the mother church |

**And what it never says:** *test · discount · offer · instead of the standard · normal price.*

---

## 2. In the room — the treasurer and the chair, not the members

> "Quick one. What do you collect on a Friday? … Right, so this is **one collection**. 9,500, once.
> Not per term, not per member — the app is yours after that.
>
> And if your fellowship actually sits under a church or a ministry, it isn't your money at all —
> they're billed for the branch instead. So which is it for you: standing on your own, or is there a
> church behind you?"

The last question is the whole pitch. "Standing on our own" closes at 9,500. "There's a church" gives
you the name of a body that pays 17,000 per branch — and every one of those names is worth several
fellowships.

---

## 3. On WhatsApp, after the meeting

> Bro, thanks for today. As promised: 9,500, once, and I'll set it up myself so you don't have to do
> anything. Send me your chair's number and I'll call him tomorrow.
>
> And the other thing — **who came through this fellowship and is pastoring somewhere now?** Three
> names is all I need. Those are the churches I should be talking to, and only you know them.

The alumni question belongs in the same message as the price. It costs the fellowship nothing to
answer, and it is worth more than the 9,500.

---

## 4. What is live and what is not (17 Nov 2026)

| | Status |
|---|---|
| The words | **Built.** One line in `components/activation/ActivationClient.tsx`, shown only while a non-standard amount is live |
| The church screen | **Unchanged.** `tier` defaults to `church`; the test-pricing banner still shows exactly where it used to |
| The 9,500 amount | **Not yet resolved from the record.** The fee still comes from the single `ACTIVATION_FEE_UGX` path |
| What is missing | `tier` on the church record (migration) + `startActivationPayment` reading it + the page passing it down |

So: the screen can *render* a campus tier, but nothing can *be* one yet. Do not set `ACTIVATION_FEE_UGX`
to force it — that route applies to every church and still shows the old banner.

**Saturday's job**, in order: migration (`tier` column, default `church`), read it in
`startActivationPayment`, pass it from the page, one test that a campus record quotes *and records*
9,500 while a church record does 17,000. Then the copy above is telling the truth.
