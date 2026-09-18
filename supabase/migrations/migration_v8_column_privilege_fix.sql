-- ============================================================
-- MIGRATION v8 — CRITICAL SECURITY FIX
-- ============================================================
-- Every "revoke update (col) on table from authenticated" statement
-- in migration_v3/v5/v6 was silently ineffective. In Postgres,
-- revoking a COLUMN-level privilege does nothing if the role still
-- holds the broader TABLE-level privilege (which Supabase grants
-- `authenticated` by default) — the table-level grant wins. Verified
-- directly against the live database: profiles.plan, profiles.role,
-- stripe_connect_status, notifications.title, shop_orders.price_cents
-- and others were all still updatable by any authenticated user.
--
-- Real-world impact: a signed-up user could send one direct API
-- request updating their own profiles row with {"role":"admin",
-- "plan":"studio"} and it would have succeeded — RLS only checked
-- WHICH ROW (their own), never WHICH COLUMNS.
--
-- THE FIX: the only way to actually restrict specific columns in
-- Postgres is the reverse of what was tried — revoke ALL update
-- access at the table level, then grant UPDATE on ONLY the columns
-- that should be self-editable. There is no table-level UPDATE left
-- to "win" over the column grant, so this actually works.
-- ============================================================

-- profiles: only these columns are genuinely a creator's own to
-- change. plan / plan_updated_at / role / stripe_connect_account_id /
-- stripe_connect_status are excluded entirely — only server code
-- using the service_role key (which bypasses grants) can touch them.
revoke update on public.profiles from authenticated;
grant update (
  username, display_name, bio, goal, niche, avatar_image, platforms,
  stats, social, media_kit, featured_work, shop_picks,
  manual_partnerships, interested_opportunities, match_profile,
  website, website_draft, paypal_email, paypal_connected_at
) on public.profiles to authenticated;

-- deal_offers: a creator may only ever flip status — never rewrite
-- who it's from/to or what it said.
revoke update on public.deal_offers from authenticated;
grant update (status) on public.deal_offers to authenticated;

-- notifications: a user may only mark their own read/unread.
revoke update on public.notifications from authenticated;
grant update (read) on public.notifications to authenticated;

-- partner_assignments: a creator may only accept/decline.
revoke update on public.partner_assignments from authenticated;
grant update (status) on public.partner_assignments to authenticated;

-- shop_orders: a creator may only mark their own order fulfilled —
-- never touch the amount, buyer info, or delivery details after
-- the fact.
revoke update on public.shop_orders from authenticated;
grant update (status) on public.shop_orders to authenticated;
