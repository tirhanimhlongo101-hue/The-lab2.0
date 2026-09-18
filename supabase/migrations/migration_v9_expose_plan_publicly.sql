-- ============================================================
-- MIGRATION v9 — expose `plan` on profiles_public
-- ============================================================
-- profiles_public is NOT a plain view — it's a real table kept in
-- sync with `profiles` by internal.sync_profiles_public(), a
-- trigger on INSERT/UPDATE/DELETE. (My first attempt at this
-- migration assumed it was a view and failed outright — good, loud
-- failure, no damage — corrected here against the trigger's real
-- definition instead of an assumption.)
--
-- Why add `plan` at all: portfolio.html needs to know a creator's
-- plan to decide whether to show the "Build your own creator
-- website" Lab-branding footer — visible on Free, hidden on
-- Pro/Studio. `plan` isn't sensitive (using the free tier isn't a
-- secret), and this is a read-only sync target anyway — it still
-- can't be written to directly from the client (see migration_v8).
-- ============================================================

alter table public.profiles_public add column if not exists plan text;

create or replace function internal.sync_profiles_public()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    delete from public.profiles_public where id = OLD.id;
    return OLD;
  end if;

  if NEW.username is not null then
    insert into public.profiles_public (
      id, username, display_name, bio, goal, niche, avatar_image,
      platforms, stats, social, media_kit, featured_work, shop_picks,
      manual_partnerships, website, created_at, plan
    )
    values (
      NEW.id, NEW.username, NEW.display_name, NEW.bio, NEW.goal, NEW.niche, NEW.avatar_image,
      NEW.platforms, NEW.stats, NEW.social, NEW.media_kit, NEW.featured_work, NEW.shop_picks,
      NEW.manual_partnerships, NEW.website, NEW.created_at, NEW.plan
    )
    on conflict (id) do update set
      username = excluded.username,
      display_name = excluded.display_name,
      bio = excluded.bio,
      goal = excluded.goal,
      niche = excluded.niche,
      avatar_image = excluded.avatar_image,
      platforms = excluded.platforms,
      stats = excluded.stats,
      social = excluded.social,
      media_kit = excluded.media_kit,
      featured_work = excluded.featured_work,
      shop_picks = excluded.shop_picks,
      manual_partnerships = excluded.manual_partnerships,
      website = excluded.website,
      plan = excluded.plan;
  else
    delete from public.profiles_public where id = NEW.id;
  end if;

  return NEW;
end;
$$;

-- Backfill any existing rows (harmless no-op right now since there are
-- zero signups, but correct for whenever this runs against real data).
update public.profiles_public pp
set plan = p.plan
from public.profiles p
where pp.id = p.id;
