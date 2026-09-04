-- Access control.
--
-- READ THIS BEFORE EDITING. Supabase does not hand you a locked-down database.
-- It pre-grants `anon` and `authenticated` broad privileges on everything in
-- `public`, and it keeps doing so for tables created later via default
-- privileges. A GRANT here therefore only ever ADDS to what is already there —
-- restricting anything means REVOKING first. NovaCars shipped a column-level
-- GRANT that read as a restriction, did nothing, and was only caught by probing
-- the deployed project.
--
-- So: revoke everything, kill the defaults, then grant back the exact list.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

alter table sellers         enable row level security;
alter table seller_contacts enable row level security;
alter table products        enable row level security;
alter table photos          enable row level security;
alter table orders          enable row level security;
alter table shipments       enable row level security;
alter table shipment_lines  enable row level security;
alter table product_stats   enable row level security;

-- Belt and braces: a policy that is accidentally permissive still cannot be
-- reached through a privilege that was never granted.
grant select on sellers, products, photos to anon, authenticated;

-- ------------------------------------------------------------ public read --
-- Storefront. Only live products, and only the seller's shopfront details —
-- phone and address live in seller_contacts, which anon has no grant on at all.
create policy live_products_are_public on products
  for select to anon, authenticated using (status = 'live');

create policy photos_of_live_products on photos
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = photos.product_id and p.status = 'live'));

create policy active_sellers_are_public on sellers
  for select to anon, authenticated using (status = 'active');

-- --------------------------------------------------------- seller's own -----
-- Every one of these is keyed on auth.uid(). A seller reading another seller's
-- orders or stats is the cross-scope bug class that has already cost time on
-- NovaX; it is prevented here and asserted in scripts/db.test.mjs.
create or replace function public.my_seller_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select seller_id from seller_contacts where user_id = auth.uid()
$$;

grant select, insert, update, delete on products, photos to authenticated;
grant select on seller_contacts, shipments, shipment_lines, product_stats to authenticated;
grant update on shipments to authenticated;
grant execute on function public.my_seller_id() to authenticated;

create policy sellers_manage_own_products on products
  for all to authenticated
  using (seller_id = public.my_seller_id())
  with check (seller_id = public.my_seller_id());

create policy sellers_manage_own_photos on photos
  for all to authenticated
  using (exists (select 1 from products p where p.id = photos.product_id and p.seller_id = public.my_seller_id()))
  with check (exists (select 1 from products p where p.id = photos.product_id and p.seller_id = public.my_seller_id()));

create policy sellers_read_own_contact on seller_contacts
  for select to authenticated using (user_id = auth.uid());

create policy sellers_read_own_shipments on shipments
  for select to authenticated using (seller_id = public.my_seller_id());

-- A seller may move their own shipment along, and nothing else. The WITH CHECK
-- repeats the ownership test on purpose: without it a seller could reassign a
-- shipment to another seller on the way out.
create policy sellers_advance_own_shipments on shipments
  for update to authenticated
  using (seller_id = public.my_seller_id())
  with check (seller_id = public.my_seller_id());

create policy sellers_read_own_lines on shipment_lines
  for select to authenticated
  using (exists (select 1 from shipments s where s.id = shipment_lines.shipment_id and s.seller_id = public.my_seller_id()));

create policy sellers_read_own_stats on product_stats
  for select to authenticated
  using (exists (select 1 from products p where p.id = product_stats.product_id and p.seller_id = public.my_seller_id()));

-- --------------------------------------------------------------- orders -----
-- Nobody selects from orders directly. Buyers have no account, so an order is
-- written by place_order() and read back by get_order(code, phone) — both
-- SECURITY DEFINER. Requiring the phone as well as the code means a guessed or
-- shoulder-surfed code on its own leaks nothing.
-- No grant on `orders` for anon, and no policy: the table is unreachable.
