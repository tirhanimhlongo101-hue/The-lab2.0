-- ============================================================
-- MIGRATION v7: creators can upload a real PDF to sell, instead
-- of only pasting an external link.
-- ============================================================
-- The bucket is PRIVATE (public: false) — nobody can hit the file
-- URL directly, ever. A creator can only read/write files inside
-- their OWN folder (enforced below by matching the first path
-- segment to their user id). The only way a buyer ever gets the
-- actual file is a short-lived signed URL generated server-side,
-- after payment, from api/stripe/shop-order-lookup.js using the
-- service_role key — the same "session id is the ticket" model as
-- the rest of that file. Restricted to PDFs, 50MB max, on purpose:
-- keeps this simple and predictable rather than a general file host.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-digital-products', 'shop-digital-products', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

create policy "Creators can upload PDFs into their own folder"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'shop-digital-products' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Creators can view files in their own folder"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'shop-digital-products' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Creators can replace files in their own folder"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'shop-digital-products' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'shop-digital-products' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Creators can delete files in their own folder"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'shop-digital-products' and (storage.foldername(name))[1] = auth.uid()::text);
-- No policy for anon at all, and no broader authenticated policy — a
-- creator can never read another creator's uploaded files, and nobody
-- who isn't logged in can read any of them either.

-- Track whether a digital order's delivery_value is an external link or
-- a path inside the bucket above, so shop-order-lookup.js knows whether
-- to hand the buyer the value as-is or turn it into a signed URL first.
alter table public.shop_orders
  add column if not exists delivery_type text not null default 'link'
    check (delivery_type in ('link', 'file'));
