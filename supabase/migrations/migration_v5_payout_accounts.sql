-- ============================================================
-- MIGRATION v5: creator payout accounts (Stripe Connect + PayPal)
-- ============================================================
-- Separate from plan billing (money flowing INTO The Lab). This is
-- money flowing OUT to creators — e.g. for partner-product payouts
-- or brand deal payments processed through the platform.
-- ============================================================

alter table public.profiles
  add column if not exists stripe_connect_account_id text,
  add column if not exists stripe_connect_status text not null default 'not_connected'
    check (stripe_connect_status in ('not_connected','pending','active','restricted')),
  add column if not exists paypal_email text,
  add column if not exists paypal_connected_at timestamptz;

-- Same pattern as plan/role: a user can update their OWN profile (existing
-- rule), but the Stripe connect account id/status must only ever be set by
-- the server (account creation + the Connect webhook confirming real status)
-- — never trusted from the client, so a compromised session can't claim a
-- fake "active" payout account. paypal_email is deliberately NOT revoked —
-- it's just a destination address the creator sets themselves, same trust
-- level as their bio or social links; the platform never treats an
-- unconfirmed PayPal email as proof of anything beyond "send money here."
revoke update (stripe_connect_account_id, stripe_connect_status) on public.profiles from authenticated;
