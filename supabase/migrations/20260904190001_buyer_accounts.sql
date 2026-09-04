-- Buyer accounts, and the hard barrier at checkout.
--
-- This reverses a decision made on 3 Sep: buyers used to check out as guests
-- and never made an account. Browsing, swiping and filling a bag are still
-- account-free — that part was right and is untouched. What changed is the
-- moment of ordering: an order needs a name, an email and a phone anyway, so
-- asking once and keeping them is strictly better than asking every time and
-- keeping nothing. It is also the only way order history can follow someone to
-- a new phone.

create table buyers (
  user_id    uuid primary key,
  name       text not null,
  email      text not null,
  phone      text not null check (phone ~ '^03[0-9]{9}$'),
  created_at timestamptz not null default now()
);
alter table buyers enable row level security;
grant select, update on buyers to authenticated;

create policy buyers_read_own on buyers
  for select to authenticated using (user_id = auth.uid());
create policy buyers_update_own on buyers
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table orders add column user_id uuid;
create index orders_user on orders (user_id, placed_at desc);
alter table threads add column user_id uuid;

/* Registering. Called straight after sign-up, while the session is fresh.
   The phone is the important one: it is what the rider dials and what links
   any guest orders already placed from this number. */
create or replace function public.register_buyer(p_name text, p_email text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_phone text := trim(p_phone);
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if v_phone !~ '^03[0-9]{9}$' then
    raise exception 'enter a Pakistani mobile number, like 0300 1234567' using errcode = 'check_violation';
  end if;

  insert into buyers (user_id, name, email, phone)
  values (auth.uid(), trim(p_name), lower(trim(p_email)), v_phone)
  on conflict (user_id) do update
    set name = excluded.name, email = excluded.email, phone = excluded.phone;

  -- Anything ordered as a guest from this number becomes theirs. Someone who
  -- bought before signing up should not have to be told their history is gone.
  update orders set user_id = auth.uid()
   where buyer_phone = v_phone and user_id is null;

  update threads set user_id = auth.uid()
   where user_id is null and device_id in (
     select device_id from threads t2 where t2.user_id = auth.uid())
   ;

  return me_buyer();
end $$;

create or replace function public.me_buyer() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when b.user_id is null then null else jsonb_build_object(
    'user_id', b.user_id, 'name', b.name, 'email', b.email, 'phone', b.phone,
    'since', b.created_at,
    'orders', (select count(*) from orders o where o.user_id = b.user_id)
  ) end
  from buyers b where b.user_id = auth.uid();
$$;

/* Order history. The whole point of the account. */
create or replace function public.my_orders() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', o.code, 'placed_at', o.placed_at, 'total', o.grand_total,
      'payment', o.payment, 'cancelled_at', o.cancelled_at,
      'units', (select coalesce(sum(sl.qty), 0) from shipments sh
                 join shipment_lines sl on sl.shipment_id = sh.id where sh.order_id = o.id),
      'parcels', (select count(*) from shipments sh where sh.order_id = o.id),
      -- An order is only as far along as its slowest parcel.
      'status', (select min(case sh.status
                   when 'placed' then 1 when 'confirmed' then 2 when 'dispatched' then 3
                   when 'delivered' then 4 when 'cancelled' then 5 else 6 end)
                 from shipments sh where sh.order_id = o.id),
      'sellers', (select jsonb_agg(distinct s.brand_name) from shipments sh
                   join sellers s on s.id = sh.seller_id where sh.order_id = o.id),
      'cover', (select ph.key from shipments sh
                 join shipment_lines sl on sl.shipment_id = sh.id
                 join photos ph on ph.product_id = sl.product_id
                where sh.order_id = o.id order by ph.position limit 1)
    ) order by o.placed_at desc)
    from orders o where o.user_id = auth.uid()), '[]'::jsonb);
end $$;

/* A signed-in buyer opens their own order by code alone — the phone check is
   what a guest needed, and their account is a stronger claim than a number. */
create or replace function public.my_order(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select get_order(o.code, o.buyer_phone)
  from orders o
  where o.code = upper(trim(p_code)) and o.user_id = auth.uid();
$$;

/* place_order gains the account. Still one transaction, still re-priced from
   the rows; the only change is that the order is stamped with who placed it. */
create or replace function public.place_order(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order_id uuid; v_code text;
  v_city text := trim(payload->'contact'->>'city');
  v_phone text := trim(payload->'contact'->>'phone');
  v_express boolean := coalesce((payload->>'express')::boolean, false);
  v_payment text := coalesce(payload->>'payment', 'cod');
  v_items int := 0; v_delivery int := 0; v_grand int := 0;
  r record; v_ship_id uuid; v_ship_items int; v_ship_fee int;
begin
  if jsonb_array_length(coalesce(payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'empty order' using errcode = 'check_violation';
  end if;

  create temp table _want on commit drop as
  select (l->>'product_id')::uuid as product_id,
         nullif(l->>'variant_id','')::uuid as variant_id,
         least(greatest((l->>'qty')::int, 1), 10) as qty
  from jsonb_array_elements(payload->'lines') l;

  create temp table _lines on commit drop as
  select p.id as product_id, p.seller_id, p.title, effective_price(p) as price,
         s.city as seller_city, w.qty, w.variant_id,
         v.stock as variant_stock, p.stock as product_stock,
         nullif(concat_ws(' / ', v.size, v.colour), '') as variant_label
    from _want w
    join products p on p.id = w.product_id
    join sellers  s on s.id = p.seller_id
    left join variants v on v.id = w.variant_id and v.product_id = p.id
   where p.status = 'live' and s.status = 'active'
   for no key update of p;

  if (select count(*) from _lines) <> (select count(*) from _want) then
    raise exception 'a listing is no longer available' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from _lines l where l.variant_id is null
              and exists (select 1 from variants v where v.product_id = l.product_id)) then
    raise exception 'pick a size before ordering' using errcode = 'check_violation';
  end if;
  if exists (select 1 from _lines where qty > coalesce(variant_stock, product_stock)) then
    raise exception 'not enough stock' using errcode = 'check_violation';
  end if;

  select coalesce(sum(price * qty), 0) into v_items from _lines;
  select coalesce(sum(delivery_fee(seller_city, v_city, seller_items, v_express)), 0) into v_delivery
  from (select seller_city, sum(price * qty)::int as seller_items
          from _lines group by seller_id, seller_city) per_seller;
  v_grand := v_items + v_delivery;

  if v_payment = 'cod' and v_grand > 50000 then
    raise exception 'cash on delivery is not available above Rs 50,000' using errcode = 'check_violation';
  end if;

  v_code := new_order_code();

  insert into orders (code, user_id, buyer_name, buyer_phone, city, area, address, landmark, notes,
                      express, payment, items_total, delivery_total, grand_total)
  values (v_code, auth.uid(), trim(payload->'contact'->>'name'), v_phone, v_city,
          trim(payload->'contact'->>'area'), trim(payload->'contact'->>'address'),
          coalesce(trim(payload->'contact'->>'landmark'), ''),
          coalesce(trim(payload->'contact'->>'notes'), ''),
          v_express, v_payment, v_items, v_delivery, v_grand)
  returning id into v_order_id;

  for r in select seller_id, max(seller_city) as seller_city, sum(price * qty)::int as items
             from _lines group by seller_id loop
    v_ship_items := r.items;
    v_ship_fee   := delivery_fee(r.seller_city, v_city, v_ship_items, v_express);
    insert into shipments (order_id, seller_id, items_total, delivery, total)
    values (v_order_id, r.seller_id, v_ship_items, v_ship_fee, v_ship_items + v_ship_fee)
    returning id into v_ship_id;
    insert into shipment_lines (shipment_id, product_id, variant_id, variant_label, title, price, qty)
    select v_ship_id, product_id, variant_id, variant_label, title, price, qty
      from _lines where seller_id = r.seller_id;
  end loop;

  update variants v set stock = v.stock - l.qty from _lines l where v.id = l.variant_id;
  update products p set stock = p.stock - l.qty
    from _lines l where p.id = l.product_id and l.variant_id is null;
  update products set status = 'sold'
   where status = 'live' and id in (select product_id from _lines) and available_stock(id) = 0;

  return get_order(v_code, v_phone);
end $$;

/* Trending: what buyers have actually been saving and opening in the last week,
   with a floor so a listing nobody has seen yet is not "trending" at rank one. */
create or replace function public.trending(p_limit int default 40) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('items', coalesce((
    select jsonb_agg(product_json(t.id) order by t.heat desc) from (
      select p.id,
             coalesce(sum(st.keeps), 0) * 3
           + coalesce(sum(st.detail_views), 0) * 2
           + coalesce(sum(st.adds), 0) * 5
           + (select count(*) from shipment_lines sl
                join shipments sh on sh.id = sl.shipment_id
               where sl.product_id = p.id and sh.status <> 'cancelled') * 8 as heat
        from products p
        join sellers s on s.id = p.seller_id
        left join product_stats st on st.product_id = p.id and st.day >= current_date - 7
       where p.status = 'live' and s.status = 'active'
         and exists (select 1 from photos ph where ph.product_id = p.id)
       group by p.id
       having coalesce(sum(st.impressions), 0) > 0
           or exists (select 1 from shipment_lines sl where sl.product_id = p.id)
       order by heat desc
       limit greatest(1, least(p_limit, 60))) t), '[]'::jsonb));
$$;

revoke all on function public.register_buyer(text, text, text) from public;
revoke all on function public.me_buyer()   from public;
revoke all on function public.my_orders()  from public;
revoke all on function public.my_order(text) from public;
revoke all on function public.trending(int) from public;

grant execute on function public.register_buyer(text, text, text) to authenticated;
grant execute on function public.me_buyer()    to authenticated;
grant execute on function public.my_orders()   to authenticated;
grant execute on function public.my_order(text) to authenticated;
grant execute on function public.trending(int) to anon, authenticated;
