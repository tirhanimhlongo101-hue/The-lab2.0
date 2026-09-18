-- ============================================================
-- MIGRATION v12 — partner drops can now have real checkout
-- ============================================================
-- Per-product choice, not platform-wide: a partner product with no
-- price set stays exactly as it's always been — a showcased,
-- gifted/promotional item with no purchase flow. Setting a price
-- turns on real checkout for that one product. Both models coexist.
--
-- Money flow is deliberately different from a creator's own Shop
-- checkout (migration_v6/v7): these are the PLATFORM's own products,
-- so payment goes straight to the platform's own Stripe account —
-- no Connect destination/transfer at checkout time at all. The
-- creator who drove the sale earns a commission afterward, tracked
-- here and paid out through the exact same admin-approved rails
-- already built for referral bonuses — nothing new to invent.
-- ============================================================

alter table public.partner_products
  add column if not exists price_cents integer check (price_cents is null or price_cents > 0);

create table public.partner_drop_sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.partner_products(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  price_cents integer not null check (price_cents > 0),
  commission_cents integer not null check (commission_cents >= 0),
  buyer_email text,
  stripe_checkout_session_id text unique not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.partner_drop_sales enable row level security;

-- Creators can see sales they drove (their commission history), same
-- transparency as every other earnings view in this app.
create policy "Creators can view their own partner drop sales"
  on public.partner_drop_sales for select
  using (auth.uid() = creator_id);

create policy "Admins can view all partner drop sales"
  on public.partner_drop_sales for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- No insert/update policy for authenticated at all — rows are only ever
-- created by the webhook and marked paid by an admin action, both using
-- the service_role key, which bypasses RLS entirely.
