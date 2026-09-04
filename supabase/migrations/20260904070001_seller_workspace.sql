-- What the seller workspace needs, and three gaps 0002 left open.
--
-- 1. A seller could not create their own seller row at all — there was no
--    insert policy anywhere. register_seller() does it, and always lands them
--    on `pending`: approval is per SELLER, once, not per listing forever.
-- 2. A seller could not read their own row until an admin had already made it
--    `active`, so a pending seller saw an empty workspace and no explanation.
-- 3. THE MONEY HOLE. 0002 granted `update on shipments to authenticated` so a
--    seller could mark a parcel dispatched. RLS restricts WHICH ROWS, never
--    WHICH COLUMNS — so the same grant let a seller rewrite items_total,
--    delivery and total on their own shipment, after the buyer had agreed to
--    them. That grant is revoked here and replaced by an RPC that can only
--    touch `status`.

-- ------------------------------------------------------------------ 3 --------
revoke update on shipments from authenticated;
drop policy if exists sellers_advance_own_shipments on shipments;

-- ------------------------------------------------------------------ 2 --------
create policy sellers_read_own_row on sellers
  for select to authenticated
  using (id = public.my_seller_id());

-- ------------------------------------------------------------------ 1 --------
create or replace function public.register_seller(
  p_brand text, p_owner text, p_phone text, p_address text, p_city text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from seller_contacts where user_id = auth.uid()) then
    raise exception 'this account already has a shop' using errcode = 'unique_violation';
  end if;
  if p_phone !~ '^03[0-9]{9}$' then
    raise exception 'phone must be a Pakistani mobile number' using errcode = 'check_violation';
  end if;

  -- 'pending' on purpose. The swipe deck's entire value is that every card is
  -- worth looking at, and there is no free way to catch a stolen photograph.
  insert into sellers (brand_name, city, status) values (trim(p_brand), trim(p_city), 'pending')
  returning id into v_id;

  insert into seller_contacts (seller_id, user_id, owner_name, phone, address)
  values (v_id, auth.uid(), trim(p_owner), trim(p_phone), trim(p_address));

  return me();
end $$;

/* Everything the workspace needs about the signed-in seller, in one call. */
create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when s.id is null then null else jsonb_build_object(
    'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'status', s.status,
    'plan', s.plan, 'trial_ends_at', s.trial_ends_at,
    'owner_name', c.owner_name, 'phone', c.phone, 'address', c.address,
    'products', (select count(*) from products p where p.seller_id = s.id),
    'live_products', (select count(*) from products p where p.seller_id = s.id and p.status = 'live'),
    'open_orders', (select count(*) from shipments sh
                    where sh.seller_id = s.id and sh.status in ('placed','confirmed'))
  ) end
  from seller_contacts c join sellers s on s.id = c.seller_id
  where c.user_id = auth.uid();
$$;

/* The shopfront fields a seller may change. Deliberately not status, plan or
   trial_ends_at — those are ours, and a plain UPDATE grant could not have kept
   them out of reach. */
create or replace function public.update_shopfront(p_brand text, p_city text, p_phone text, p_address text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := my_seller_id();
begin
  if v_id is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  if p_phone !~ '^03[0-9]{9}$' then
    raise exception 'phone must be a Pakistani mobile number' using errcode = 'check_violation';
  end if;
  update sellers set brand_name = trim(p_brand), city = trim(p_city) where id = v_id;
  update seller_contacts set phone = trim(p_phone), address = trim(p_address) where seller_id = v_id;
  return me();
end $$;

/* Publishing. A listing goes live immediately once the SELLER is approved;
   until then it waits with them. Approval is a person, once — not a queue that
   grows forever. */
create or replace function public.publish_product(p_product uuid, p_live boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_seller uuid := my_seller_id(); v_status text; v_stock int;
begin
  if v_seller is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  -- Both tables have a `status`; qualify or Postgres refuses the reference.
  select s.status, p.stock into v_status, v_stock
    from sellers s, products p
   where p.id = p_product and p.seller_id = v_seller and s.id = v_seller;
  if not found then raise exception 'not your listing' using errcode = 'insufficient_privilege'; end if;

  if not p_live then
    update products set status = 'draft' where id = p_product;
    return 'draft';
  end if;
  if v_stock <= 0 then raise exception 'add stock before publishing' using errcode = 'check_violation'; end if;
  if not exists (select 1 from photos where product_id = p_product) then
    raise exception 'add at least one photo before publishing' using errcode = 'check_violation';
  end if;

  update products set status = case when v_status = 'active' then 'live' else 'pending' end
   where id = p_product;
  return (select status from products where id = p_product);
end $$;

/* The order inbox.
   A seller has to see the buyer's name, phone and address to deliver — but
   `orders` has no grant for `authenticated` and must not get one, or every
   seller reads every buyer. This returns only the rows belonging to the caller's
   own shipments. */
create or replace function public.my_shipments() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'placed_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', sh.id, 'code', o.code, 'placed_at', o.placed_at, 'status', sh.status,
      'payment', o.payment, 'express', o.express,
      'items_total', sh.items_total, 'delivery', sh.delivery, 'total', sh.total,
      'buyer', jsonb_build_object(
        'name', o.buyer_name, 'phone', o.buyer_phone, 'city', o.city,
        'area', o.area, 'address', o.address, 'landmark', o.landmark, 'notes', o.notes),
      'lines', (select jsonb_agg(jsonb_build_object('title', sl.title, 'price', sl.price, 'qty', sl.qty) order by sl.title)
                from shipment_lines sl where sl.shipment_id = sh.id)
    ) as x
    from shipments sh
    join orders o on o.id = sh.order_id
    where sh.seller_id = my_seller_id()
  ) t;
$$;

/* Advancing a parcel. Forward only, and status is the only thing it can touch. */
create or replace function public.set_shipment_status(p_shipment uuid, p_status text)
returns text language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  if p_status not in ('confirmed','dispatched','delivered','refused') then
    raise exception 'not a status a seller can set' using errcode = 'check_violation';
  end if;
  select status into v_current from shipments
   where id = p_shipment and seller_id = my_seller_id();
  if not found then raise exception 'not your parcel' using errcode = 'insufficient_privilege'; end if;
  if v_current in ('delivered','refused','cancelled') then
    raise exception 'this parcel is already closed' using errcode = 'check_violation';
  end if;
  update shipments set status = p_status where id = p_shipment;
  return p_status;
end $$;

/* Deleting a listing.
   Supabase Storage has NO CASCADE — deleting this row will not remove the
   photographs, and the orphans then collide with the next upload and poison the
   id for good. So the object keys are returned here and the workspace deletes
   them through the Storage API immediately afterwards. */
create or replace function public.delete_product(p_product uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_keys jsonb;
begin
  if not exists (select 1 from products where id = p_product and seller_id = my_seller_id()) then
    raise exception 'not your listing' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from shipment_lines sl where sl.product_id = p_product) then
    raise exception 'this listing has been ordered and cannot be deleted' using errcode = 'foreign_key_violation';
  end if;
  select coalesce(jsonb_agg(key), '[]'::jsonb) into v_keys from photos where product_id = p_product;
  delete from products where id = p_product;
  return v_keys;
end $$;

revoke all on function public.register_seller(text,text,text,text,text)   from public;
revoke all on function public.me()                                        from public;
revoke all on function public.update_shopfront(text,text,text,text)       from public;
revoke all on function public.publish_product(uuid, boolean)              from public;
revoke all on function public.my_shipments()                              from public;
revoke all on function public.set_shipment_status(uuid, text)             from public;
revoke all on function public.delete_product(uuid)                        from public;

grant execute on function public.register_seller(text,text,text,text,text) to authenticated;
grant execute on function public.me()                                      to authenticated;
grant execute on function public.update_shopfront(text,text,text,text)     to authenticated;
grant execute on function public.publish_product(uuid, boolean)            to authenticated;
grant execute on function public.my_shipments()                            to authenticated;
grant execute on function public.set_shipment_status(uuid, text)           to authenticated;
grant execute on function public.delete_product(uuid)                      to authenticated;
