-- ============================================================
-- MIGRATION v3: plans, roles, brand offers, partner products
-- ============================================================
-- Run this in Supabase SQL Editor, same as every migration before it.
-- ============================================================


-- ------------------------------------------------------------
-- 1. PLAN + ROLE on profiles
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists plan text not null default 'free' check (plan in ('free','pro','studio')),
  add column if not exists plan_updated_at timestamptz default now(),
  add column if not exists role text not null default 'creator' check (role in ('creator','brand','admin'));

-- CRITICAL: a logged-in user can update their OWN profile row (that's the
-- correct, existing rule) — but plan and role must never be something a
-- user can grant themselves, no matter what the client sends. This isn't
-- enforced by hiding a button — it's enforced here, at the column level,
-- so even a direct API call with a valid session cannot touch these two
-- columns. Only the service_role key (used server-side only — by webhook
-- handlers and the admin panel) can ever change them.
revoke update (plan, plan_updated_at, role) on public.profiles from authenticated;

-- Admins need to see the full user list to manage plans/roles from the
-- admin panel. This only grants SELECT — the column-level protection
-- above still applies regardless of who's looking, so this can't be
-- used to bypass the plan/role write lock.
create policy "Admins can view all profiles"
  on public.profiles for select
  using (exists (select 1 from public.profiles p2 where p2.id = auth.uid() and p2.role = 'admin'));


-- ------------------------------------------------------------
-- 2. deal_offers — a brand account sends an offer to a specific creator
-- ------------------------------------------------------------
create table public.deal_offers (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.profiles(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  brand_name text not null check (char_length(brand_name) <= 120),
  message text default '' check (char_length(message) <= 2000),
  budget text default '',
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz default now()
);

alter table public.deal_offers enable row level security;

create policy "Brands can view offers they sent"
  on public.deal_offers for select
  using (auth.uid() = brand_id);

create policy "Creators can view offers sent to them"
  on public.deal_offers for select
  using (auth.uid() = creator_id);

create policy "Only brand-role accounts can send offers"
  on public.deal_offers for insert
  with check (
    auth.uid() = brand_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'brand')
  );

-- Creators may only ever change the status field (accept/decline) — never
-- rewrite the offer's content. Enforced the same way as plan/role above:
-- at the column-privilege level, not just by convention in the app code.
create policy "Creators can respond to their own offers"
  on public.deal_offers for update
  using (auth.uid() = creator_id)
  with check (auth.uid() = creator_id);

revoke update (brand_id, creator_id, brand_name, message, budget) on public.deal_offers from authenticated;


-- ------------------------------------------------------------
-- 3. partner_products — the pool of products/brands YOU (admin) can
-- offer creators to feature. Nobody but admin can create or browse
-- the full catalog — creators only ever see what's been assigned to
-- them specifically, via partner_assignments below.
-- ------------------------------------------------------------
create table public.partner_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) <= 120),
  brand_name text not null check (char_length(brand_name) <= 120),
  kind text not null default 'physical' check (kind in ('physical','digital','affiliate')),
  price_display text default '',
  description text default '' check (char_length(description) <= 2000),
  terms text default '' check (char_length(terms) <= 4000), -- the "you're the seller/face, not the owner" contract text
  image_url text default '',
  active boolean not null default true,
  created_at timestamptz default now()
);

alter table public.partner_products enable row level security;

create policy "Admins manage the partner product catalog"
  on public.partner_products for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));


-- ------------------------------------------------------------
-- 4. partner_assignments — which creator has been offered which
-- partner product. This is how "give this influencer this product"
-- actually happens, one creator/product pair at a time.
-- ------------------------------------------------------------
create table public.partner_assignments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.partner_products(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'offered' check (status in ('offered','accepted','declined')),
  assigned_at timestamptz default now(),
  unique(product_id, creator_id)
);

alter table public.partner_assignments enable row level security;

create policy "Creators can view their own assignments"
  on public.partner_assignments for select
  using (auth.uid() = creator_id);

create policy "Creators can respond to their own assignments"
  on public.partner_assignments for update
  using (auth.uid() = creator_id)
  with check (auth.uid() = creator_id);

revoke update (product_id, creator_id) on public.partner_assignments from authenticated;

create policy "Admins manage all assignments"
  on public.partner_assignments for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));


-- ------------------------------------------------------------
-- 5. notifications — generic in-app notifications. Creators are never
-- surprised by a new partner or offer silently appearing; this is
-- what tells them. Only ever created by triggers (below) or the
-- server — never directly insertable by a regular client.
-- ------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text default '',
  related_id uuid,
  read boolean not null default false,
  created_at timestamptz default now()
);

alter table public.notifications enable row level security;

create policy "Users can view their own notifications"
  on public.notifications for select
  using (auth.uid() = user_id);

create policy "Users can mark their own notifications read"
  on public.notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke update (user_id, type, title, body, related_id) on public.notifications from authenticated;
-- No insert policy for authenticated/anon at all — notifications are only
-- ever created by the triggers below (SECURITY DEFINER) or by admin
-- server-side actions using the service_role key.

-- Auto-notify a creator when they're assigned a new partner product
create function internal.notify_partner_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_name text;
begin
  select name into product_name from public.partner_products where id = new.product_id;
  insert into public.notifications (user_id, type, title, body, related_id)
  values (new.creator_id, 'partner_offer', 'New partner product offered', 'The Lab has offered you: ' || coalesce(product_name, 'a product') || '. Review it in your dashboard.', new.id);
  return new;
end;
$$;

create trigger on_partner_assignment_created
  after insert on public.partner_assignments
  for each row execute procedure internal.notify_partner_assignment();

-- Auto-notify a creator when a brand sends them a deal offer
create function internal.notify_deal_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (user_id, type, title, body, related_id)
  values (new.creator_id, 'deal_offer', 'New offer from ' || new.brand_name, coalesce(new.message, ''), new.id);
  return new;
end;
$$;

create trigger on_deal_offer_created
  after insert on public.deal_offers
  for each row execute procedure internal.notify_deal_offer();


-- ------------------------------------------------------------
-- 6. payment_events — raw audit log of every webhook received from
-- Stripe/PayPal/Paystack. Only the server (service_role) ever writes
-- here. Admin can read it for support/debugging; nobody else can.
-- This table is what a webhook handler updates profiles.plan FROM —
-- never the other way around.
-- ------------------------------------------------------------
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe','paypal','paystack','manual')),
  event_type text not null,
  user_id uuid references public.profiles(id) on delete set null,
  raw_payload jsonb,
  processed_at timestamptz default now()
);

alter table public.payment_events enable row level security;

create policy "Admins can view payment events"
  on public.payment_events for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No insert/update/delete policy for anyone via the client API —
-- only the service_role key (webhook handlers) ever writes here.


-- ------------------------------------------------------------
-- 7. Let admins manage the opportunities feed from the admin panel
-- (it was previously SQL-editor-only, since only a select policy existed)
-- ------------------------------------------------------------
create policy "Admins manage the opportunities feed"
  on public.opportunities for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));


-- ------------------------------------------------------------
-- 8. Make yourself the first admin
-- ------------------------------------------------------------
-- There is no way to become admin through the app itself, by design —
-- that's the whole point of the protection above. Run this ONE line
-- yourself, once, replacing the email with your own account's email:
--
--   update public.profiles set role = 'admin' where email = 'YOUR-EMAIL-HERE';
--
-- This works because you're running it directly in the SQL Editor,
-- which uses full database privileges — not through the app's anon key.
