-- ============================================================
-- MIGRATION v10 — counter-offers on deal_offers
-- ============================================================
-- A creator reviewing an offer can now push back instead of just
-- accept/decline: they write what they'd actually need (budget
-- and/or terms), we set status to 'countered', and the brand sees
-- it on their side with a clear next step (send an improved offer,
-- or decline). The original offer's brand_id/creator_id/brand_name/
-- message/budget stay exactly as the brand sent them — a counter
-- is additive, never a rewrite of what was actually offered, so
-- there's a clean, undisputed record of what was proposed vs. what
-- was asked for in return.
-- ============================================================

alter table public.deal_offers drop constraint if exists deal_offers_status_check;
alter table public.deal_offers add constraint deal_offers_status_check
  check (status in ('pending', 'accepted', 'declined', 'countered'));

alter table public.deal_offers
  add column if not exists counter_message text,
  add column if not exists counter_budget text;

-- Additive grant — migration_v8 already restricted authenticated to
-- (status) only on this table; this adds two more self-editable columns
-- without reopening anything else (brand_id, creator_id, brand_name, the
-- ORIGINAL message/budget stay locked to server-only, same as before).
grant update (counter_message, counter_budget) on public.deal_offers to authenticated;
