-- ============================================================
-- MIGRATION v4: let public portfolio visitors actually see
-- accepted partner-product drops (bug found while re-verifying
-- v3 against how portfolio.html actually queries the database)
-- ============================================================
-- portfolio.html runs with NO session (anonymous visitor) and does:
--   supabaseClient.from('partner_assignments')
--     .select('*, partner_products(*)')
--     .eq('creator_id', profileId).eq('status', 'accepted')
--
-- migration_v3.sql only granted SELECT on partner_assignments to the
-- assignment's own creator and to admins — an anonymous visitor got
-- zero rows every time, silently. Same problem on partner_products:
-- only admins could read it, so even if the assignment row came back,
-- the joined partner_products(*) would come back null. This fixes both,
-- narrowly — only accepted assignments to active products are exposed,
-- nothing else about the catalog or other creators' pending offers.
-- ============================================================

create policy "Anyone can view accepted partner assignments"
  on public.partner_assignments for select
  using (status = 'accepted');

create policy "Anyone can view active partner products"
  on public.partner_products for select
  using (active = true);
