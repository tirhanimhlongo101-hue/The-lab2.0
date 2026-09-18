-- ============================================================
-- MIGRATION v11 — referral program ($15 one-time per paid signup)
-- ============================================================
-- Design choices, and why:
--
-- 1. `referred_by` is SERVER-ONLY, never client-writable, and can
--    only ever be set ONCE (enforced by a trigger, not just "please
--    don't edit this"). Without that, a user could sign up normally,
--    then later edit their own referred_by to point at a friend to
--    manufacture a referral bonus that never actually happened. The
--    only legitimate path to set it is api/set-referral.js, called
--    once right after signup, before onboarding.
--
-- 2. `referral_commissions` has ONE row per referred person, EVER
--    (unique constraint on referred_id) — not per-payment. This is
--    what makes it a genuine one-time bonus rather than something
--    that could be farmed by cancelling and resubscribing.
--
-- 3. No insert/update policy for authenticated at all. Rows are only
--    ever created by the webhook (first successful paid subscription)
--    and only ever marked paid by an admin action — both using the
--    service_role key, which bypasses RLS entirely. A client can
--    never fabricate or approve their own referral payout.
-- ============================================================

alter table public.profiles add column if not exists referred_by uuid references public.profiles(id);

create function internal.lock_referred_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if OLD.referred_by is not null and NEW.referred_by is distinct from OLD.referred_by then
    raise exception 'referred_by cannot be changed once set';
  end if;
  return NEW;
end;
$$;

create trigger lock_referred_by_trigger
  before update on public.profiles
  for each row execute procedure internal.lock_referred_by();

create table public.referral_commissions (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  referred_id uuid not null unique references public.profiles(id) on delete cascade,
  plan text not null check (plan in ('pro', 'studio')),
  amount_cents integer not null default 1500,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.referral_commissions enable row level security;

create policy "Referrers can view their own commissions"
  on public.referral_commissions for select
  using (auth.uid() = referrer_id);

create policy "Admins can view all commissions"
  on public.referral_commissions for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
