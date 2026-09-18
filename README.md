# The Lab

## SECURITY — read this one first

`migration_v8_column_privilege_fix.sql` fixes a real hole: every
`revoke update (column) on table from authenticated` statement in
`migration_v3.sql`/`v5`/`v6` was silently ineffective (Postgres lets a
broader table-level grant override a narrower column-level revoke — the
opposite of what was intended). Verified directly against the live
database before and after. Before the fix, any signed-up user could send
one direct API request and set their own `plan` to `'studio'` and `role`
to `'admin'` — a full privilege escalation, live on production, undetected
by Supabase's own advisor checks. It's fixed now (verified column-by-
column, and re-confirmed with a zero-issue security check) — but if
you've had any real signups before this fix went in, it's worth manually
checking `select * from profiles where role = 'admin' or plan != 'free'`
in the SQL Editor for anything you didn't set yourself.

## Real status as of this bundle (be skeptical of anything that claims otherwise)

- **Supabase project `The-Lab`** is live and its schema is fully up to date —
  I applied `migration_v3.sql`, `migration_v4_public_partner_read.sql`, and
  `migration_v5_payout_accounts.sql` directly. `get_advisors` security check
  returns zero issues.
- **There are zero signups (`auth.users` is empty).** Nobody has an account
  yet, which also means **there is no admin.** Sign up once through
  `signup.html` on your deployed site, then either run the one-line SQL at
  the bottom of `migration_v3.sql` yourself, or tell me your email and I can
  set it directly.
- `onboarding.html` and `config.example.js` did not exist in either upload
  you gave me, even though `signup.html`/`dashboard.html`/`editor.html` all
  reference them. I rebuilt `onboarding.html` from scratch (username/display
  name/goal/niche/platforms, matching the existing `profiles` schema exactly)
  and added `config.example.js` as a template. **Copy `config.example.js` to
  `config.js` and fill in your real Supabase URL + anon key before deploying
  — the site will not load without it.**
- Fixed a real bug found while re-checking `migration_v3.sql` against how
  `portfolio.html` actually queries the database: anonymous visitors had no
  RLS policy letting them read `partner_assignments`/`partner_products`, so
  the "Lab partner" badge would never have shown up on anyone's public page.
  See `migration_v4_public_partner_read.sql`.
- Added creator payout accounts (`migration_v5_payout_accounts.sql` +
  `api/stripe/create-connect-account.js` + `api/stripe/connect-webhook.js` +
  `api/paypal/set-payout-email.js` + `api/admin/send-payout.js` + the new
  "Payouts" section in `dashboard.html`'s Settings area + a "Send payout"
  button in `admin.html`). This is separate from subscription billing — it's
  how money gets sent *to* creators.
- **Real in-platform checkout for creators' own Shop products** (not just
  Lab partner drops): `migration_v6_shop_orders.sql` +
  `api/stripe/create-shop-checkout.js` + `api/stripe/shop-order-lookup.js` +
  the extended webhook + the new "Sell through The Lab" option on each Shop
  product in `dashboard.html`. When enabled, Stripe itself splits the
  payment at checkout — 98% goes straight into the creator's connected
  Stripe account, 2% stays with The Lab — with zero admin action, and zero
  delay. Works for digital products (buyer gets a delivery link
  automatically on the success page) and physical ones (Stripe collects
  their shipping address for the creator to fulfill). A creator's products
  sold via an external link (Etsy, Shopify, etc.) are unaffected — that
  money never touches The Lab.
- **Digital products can now be a real uploaded PDF**, not just a link:
  `migration_v7_digital_file_uploads.sql` adds a private Supabase Storage
  bucket (`shop-digital-products`, PDF-only, 50MB max) that a creator can
  only read/write inside their own folder. Nobody — not even another
  creator — can access the raw file. A buyer only ever gets a fresh,
  7-day signed download link, generated on the fly by
  `api/stripe/shop-order-lookup.js` after they've paid. Pasting a link is
  still supported as a fallback if a creator prefers to host the file
  themselves.

## Deploy steps

1. Copy `config.example.js` → `config.js`, fill in your Supabase URL + anon key.
2. Push this whole folder to GitHub, connect it to Vercel (or wherever you
   host), and set the environment variables below.
3. Sign up on your live site once. Tell me the email you used, or run:
   ```sql
   update public.profiles set role = 'admin' where email = 'YOU@EXAMPLE.COM';
   ```
4. Visit `/admin.html`.
5. In Supabase Dashboard → Authentication → URL Configuration, add your
   live site's `/reset-password.html` URL to the Redirect URLs allow-list
   — password reset emails won't work without this; Supabase silently
   ignores a `redirectTo` that isn't on that list.

## Environment variables

| Variable | Where it's used | Where to get it |
|---|---|---|
| `SUPABASE_URL` | every `api/` file | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | every `api/` file | Supabase → Project Settings → API (keep secret, server-only) |
| `PUBLIC_SITE_URL` | checkout + Connect redirects | your live site URL |
| `STRIPE_SECRET_KEY` | all Stripe files | Stripe → Developers → API keys |
| `STRIPE_PRICE_ID_PRO` / `STRIPE_PRICE_ID_STUDIO` | `create-checkout-session.js` | Stripe → your two subscription Prices |
| `STRIPE_WEBHOOK_SECRET` | `api/stripe/webhook.js` | Stripe → Webhooks → your **own-account** endpoint |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `api/stripe/connect-webhook.js` | Stripe → Webhooks → a **second**, separate endpoint listening on **connected accounts** |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | `api/admin/send-payout.js` | developer.paypal.com → your app |
| `PAYPAL_ENV` | `api/admin/send-payout.js` | `"sandbox"` while testing, `"live"` when real |
| `ANTHROPIC_API_KEY` | `api/ai-edit.js`, `api/analyze-deal.js` | console.anthropic.com → API Keys — costs real money per call, which is why both files enforce the plan/rate-limit check first |

Stripe subscription billing and PayPal/Stripe payout-sending both need their
respective keys before those flows do anything beyond a graceful "not set up
yet" message — nothing will silently half-work.

## Still not built (unchanged from before)

Paystack for *subscription billing*, content moderation, and tests. (File
uploads now partly exist — see the digital-product PDF upload above — but
there's no general-purpose file upload elsewhere yet.)

## Product decision: no custom domains, on purpose

## Partner drop checkout (new) — both models, per-product

Resolves the open question from before. A partner product with no price
set stays exactly as it's always been — a showcased, gifted item, no
purchase flow. Setting a price in `admin.html` turns on real checkout for
that one product. Both coexist; it's a per-product choice, not
platform-wide.

The money flow is deliberately different from a creator's own Shop
checkout: these are **your** products, so payment goes straight to your
own Stripe balance (`api/stripe/create-partner-checkout.js` sets no
`transfer_data` at all). The creator who showcased it earns a commission
afterward — `PARTNER_DROP_CREATOR_COMMISSION_RATE` in `lib/commission.js`,
defaulting to 20%, change that one number to change it everywhere. You
see every sale and pay the commission with one click in `admin.html`,
straight to whichever payout method the creator connected — same rails
already built for referrals, nothing new to invent there.

Checked one thing that could easily have been a repeat of the earlier
column-privilege bug: `has_table_privilege('authenticated', ...,
'INSERT')` returns `true` on the new `partner_drop_sales` table (that's
just Supabase's default grant) — but zero RLS policies exist for
INSERT/UPDATE on it, and with RLS enabled, an empty policy set means
Postgres denies the operation entirely regardless of the table-level
grant. Different mechanism from the earlier bug (that was about which
*columns* are writable once a write is otherwise allowed; this is about
whether a write is allowed *at all*) — verified safe, not reused blindly.

## Password reset (new) — a real gap, not an edge case

There was no way for anyone to recover a forgotten password, anywhere —
no "Forgot password?" link, no admin tool, nothing. Fixed:
- `signup.html` — a "Forgot your password?" link (shown in login mode)
  triggers Supabase's built-in `resetPasswordForEmail`. Deliberately
  shows the same message whether or not that email has an account —
  confirming which emails are registered is its own information leak.
- `reset-password.html` — where the emailed link actually lands. Handles
  Supabase's recovery session properly (that session can only ever be
  used to set a new password, nothing else, and expires on its own), and
  shows a clear "this link isn't valid" state if it's expired or already
  used, rather than a page that hangs forever.
- Also caught and fixed the same stale "Store & payments launching soon"
  footer line on `signup.html` that was already fixed on `landing.html`
  earlier — missed it the first time since I only checked one file then.

## Referral program — $15 one-time (new)

Every creator gets a personal link (`signup.html?ref=username`, shown in
a new "Refer & earn" dashboard section) — the first time someone they
refer becomes a paying Pro or Studio subscriber, the referrer gets $15,
paid to whichever payout method they've already connected (Stripe or
PayPal). This is deliberately the simpler of two models discussed —
one-time and bounded, not recurring — see the reasoning in this
conversation if you revisit that decision later.

How it's actually enforced, not just described:
- `referred_by` on `profiles` is set exactly once, only by
  `api/set-referral.js` using the service_role key — a client can never
  write it directly (verified: `has_column_privilege` returns `false`).
  A database trigger (`lock_referred_by_trigger`) backs this up
  independently — even a bug in that one file couldn't let someone
  rewrite their own attribution later to redirect a bonus to a friend.
- `referral_commissions` has a **unique constraint on `referred_id`** —
  one row per referred person, ever, not per payment. That's what makes
  it a genuine one-time bonus rather than something farmable by
  cancelling and resubscribing.
- The commission is created by `api/stripe/webhook.js` the moment a
  first paid `checkout.session.completed` fires — the same event that
  was already setting `plan`. No separate cron job or scheduled task
  needed, which was the whole point of choosing one-time over recurring.
- Admin sees every pending/paid commission in `admin.html` and pays with
  one click via `api/admin/pay-referral.js` — same payout rails already
  built for partner drops, no new payment infrastructure needed.

## Full audit pass (new) — found and fixed several real gaps

Systematically cross-checked every `/api/` call against files that exist,
every internal page link, every database table reference, and the
Stripe subscription lifecycle. Found and fixed:

1. **`mediakit.html` didn't exist.** `dashboard.html` has had a working
   "Open →" button since it was built, explicitly described as *"A
   shareable one-pager for brands"* — every click 404'd. Built now: a
   clean, printable page (`window.print()` works properly via a print
   stylesheet) showing intro, stats, services, and social links, at
   `mediakit.html?u=username`, same public-page pattern as `portfolio.html`.
2. **Cancelling a Stripe subscription would never have actually downgraded
   anyone.** `create-checkout-session.js` set `metadata` on the Checkout
   Session itself, but Stripe subscriptions don't inherit that
   automatically — the Subscription object had its own, empty metadata.
   `webhook.js`'s `customer.subscription.deleted` handler was reading
   `sub.metadata?.supabase_user_id`, which was always `undefined`. Fixed
   by also setting `subscription_data.metadata` at checkout creation, and
   added a `customer.subscription.updated` handler too — covers failed
   renewal payments and plan changes made from Stripe's own customer
   billing portal, not just full cancellation.
3. **No way to delete a logged deal, anywhere** — the database already
   allowed it (`Users can delete their own deals` policy existed from the
   original schema), the button just didn't exist. Added.
4. **Lab partner drop tiles on a portfolio page were dead links**
   (`href="#"`, did nothing when clicked, looked like a bug). Fixed the
   dishonest part — they now render as plain info rather than a fake
   clickable link — but see the open question below, which is a bigger
   decision than a bug fix.

### Resolved — see "Partner drop checkout" section further down

This used to be an open question ("do partner drops need real checkout
or stay gifted?"). Answer: both, per-product. Built below.

## AI features — built for real this time (new)

Two real gaps found and fixed:

1. **`/api/ai-edit.js` didn't exist at all.** `editor.html` had been calling
   it since it was built — every "Ask AI to edit" click 404'd. Built now,
   using the Claude API (`ANTHROPIC_API_KEY` needed). Same plan-gating and
   daily cap as before, enforced in `lib/authAndLimit.js` — this wasn't
   new, it just had nothing behind it.
2. **The red-flag checker was never actually AI** — it was a plain
   JavaScript function checking for the literal words "unlimited" and
   "forever." Replaced with `/api/analyze-deal.js`, a real Claude call that
   reads the actual terms and returns specific, explained flags (unfair
   pay for the scope, one-sided usage rights, no kill fee, vague
   deliverables, etc.) plus a ready-to-send message asking for better
   terms. The old keyword checker still exists as a free, instant, offline
   fallback if the AI call fails or the daily cap is hit — nobody is ever
   left with a spinner and nothing.

**Counter-offers, the "send it back" part of the ask:** a creator
reviewing a brand's offer can now click "Ask for better terms" instead of
just accept/decline — write what budget or terms would actually work, and
the offer flips to `countered`. The brand sees exactly what was asked for
on their dashboard and can send an improved offer with one click (pre-
filled from the creator's counter). `migration_v10_counter_offers.sql`
adds this — the original offer's brand_id/brand_name/message/budget stay
immutable (server-only, from migration_v8's lockdown); only `status`,
`counter_budget`, `counter_message` are the creator's to write, verified
column-by-column same as everywhere else.

This only applies to brand-sent offers (`deal_offers`) — there's an actual
brand account to send it back to. The manual "log a deal I already have"
checker (for deals with brands not on the platform) still gets the same
smart analysis and suggested message — the creator just copies it and
sends it themselves, since there's no in-platform brand to route it to.


Deliberately not offering custom domains, at any tier, ever — not a
"someday" item. `thelab.me/username` is meant to work like `.substack.com`
does for writers: a brand seeing that domain is itself a trust signal
("this creator went through The Lab's tools/verification"), and that
signal only holds if creators stay on it rather than migrating to their
own domain once they're established. If this ever gets revisited: domain
and feature access are two separate things technically (a custom domain
normally doesn't strip functionality — it's just a different address
pointing at the same app), so "leave our domain, lose our tools" would be
a rule someone has to deliberately build, not something that happens on
its own.

## Portfolio-as-the-product repositioning (new)

Free vs. Pro is now sold around the page itself, not just abstract tools:
- **Free**: 2 themes (Editorial, Paper), a "Build your own creator website"
  Lab badge on the page footer, deal logging capped at 5.
- **Pro/Studio**: every theme + full custom colors, no Lab badge, unlimited
  deals — plus the AI/flagging tools, now positioned as "also included"
  rather than the headline.

What's real vs. what's a client-side nudge, honestly:
- The Lab badge visibility and the 5-deal cap are enforced by real checks
  (`profile.plan`, `deals.length`) — but both are **client-side JavaScript
  checks, not database-level enforcement**, unlike `plan`/`role` themselves
  (which migration_v8 locks down hard). Someone editing their own browser
  console could remove the badge or add a 6th deal by calling the Supabase
  client directly. This is a deliberate, proportionate choice — unlike AI
  usage (which costs real API money and IS enforced server-side in
  `authAndLimit.js`), a free user seeing an extra theme or an extra logged
  deal costs you nothing. If that changes, say so and I'll move the check
  server-side.
- **"Manage multiple creator pages" (Studio) is still not built** — it's
  mentioned in copy as aspirational/roadmap, the same honest flag as
  before. Don't let anyone pay for Studio expecting it to work today.
  (Custom domains are intentionally not on this list at all — see the
  product-decision note above.)

## Brand-to-creator offers (new)

`brand-dashboard.html` — a brand searches for a creator by username,
writes an offer with a budget and message, and sends it. This was a real
gap before: the `deal_offers` table and its notification trigger existed
since `migration_v3.sql`, but no page ever actually created a row in it,
so nothing could happen end to end. Now it does — the creator gets
notified instantly and sees the offer in a new "Offers" section on their
dashboard, with Accept/Decline buttons. `dashboard.html` also now checks
`role`, and redirects any `'brand'` account straight to
`brand-dashboard.html` instead of showing them creator-only tools.

## Folder structure

```
/                     marketing + app pages
/api/stripe/          subscription billing + Stripe Connect payouts
/api/paypal/          PayPal payout email
/api/admin/           admin-only server actions (plan, role, send-payout)
/lib/                 shared server-side helpers
/supabase/migrations/ SQL run against the live database, in order
```
