-- ============================================================
-- MIGRATION v6: in-platform Shop checkout for creators' own
-- products/digital guides — not just Lab partner drops anymore.
-- ============================================================
-- Money flow: buyer pays on a Stripe Checkout page. Stripe itself
-- splits the payment at the moment of payment — 2% (application
-- fee) stays on The Lab's own Stripe balance, the other 98% is
-- transferred straight into the CREATOR's connected Stripe account
-- (profiles.stripe_connect_account_id) via transfer_data on the
-- PaymentIntent. Nobody at The Lab has to click anything for this
-- to happen — see api/stripe/create-shop-checkout.js.
--
-- This table exists so a creator can see what sold and fulfill it
-- (a physical item needs their attention; a digital item's link
-- was already handed to the buyer automatically) — and so a buyer
-- who just paid can be shown their digital delivery link on the
-- success page (see api/stripe/shop-order-lookup.js) without ever
-- needing an account or touching a row-level-secured table.
-- ============================================================

create table public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null,
  item_name text not null,
  kind text not null check (kind in ('digital','physical')),
  price_cents integer not null check (price_cents > 0),
  commission_cents integer not null check (commission_cents >= 0),
  buyer_email text,
  shipping_address jsonb,
  delivery_value text,
  stripe_checkout_session_id text unique not null,
  stripe_payment_intent_id text,
  status text not null default 'paid' check (status in ('paid','fulfilled','refunded')),
  created_at timestamptz not null default now()
);

alter table public.shop_orders enable row level security;

-- Only the creator who made the sale can see their own orders (buyer
-- emails and shipping addresses are personal data — nobody else,
-- including other creators, should ever see them). Admins can view
-- for support/dispute purposes, same pattern as every other admin
-- read in this app.
create policy "Creators can view their own shop orders"
  on public.shop_orders for select
  using (auth.uid() = creator_id);

create policy "Creators can mark their own orders fulfilled"
  on public.shop_orders for update
  using (auth.uid() = creator_id)
  with check (auth.uid() = creator_id);

revoke update (item_id, item_name, kind, price_cents, commission_cents, buyer_email, shipping_address, delivery_value, stripe_checkout_session_id, stripe_payment_intent_id) on public.shop_orders from authenticated;
-- (status is the only column a creator can change — e.g. marking a physical order "fulfilled" once shipped)

create policy "Admins can view all shop orders"
  on public.shop_orders for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- No insert/delete policy for authenticated or anon at all — rows are
-- only ever created by the webhook using the service_role key, which
-- bypasses RLS. A client can never fabricate a "paid" order.
