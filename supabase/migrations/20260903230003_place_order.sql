-- Placing an order.
--
-- The browser sends product ids and quantities. It does NOT send prices — a
-- price that arrives from a browser is a price an attacker chose. Everything
-- that decides what is owed is read here, inside one transaction, with the
-- product rows locked.
--
-- These constants mirror public/js/money.mjs. scripts/db.test.mjs asserts the
-- two agree, so the pair cannot drift apart unnoticed.

create or replace function public.delivery_fee(
  seller_city text, buyer_city text, items_total integer, express boolean
) returns integer language sql immutable as $$
  select
    case when items_total >= 5000 then 0
         when lower(trim(seller_city)) = lower(trim(buyer_city)) then 149
         else 249
    end
    -- Express is a real cost to the seller, so the free-delivery threshold
    -- waives the standard fee only. It never waives the surcharge.
    + case when express then 120 else 0 end
$$;

-- Order codes get read aloud down a phone line, so O, I, 1 and 0 are left out.
create or replace function public.new_order_code() returns text
  language plpgsql volatile as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
begin
  loop
    candidate := 'NM-' || (
      select string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
      from generate_series(1, 6)
    );
    exit when not exists (select 1 from orders where code = candidate);
  end loop;
  return candidate;
end $$;

create or replace function public.place_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id   uuid;
  v_code       text;
  v_city       text := trim(payload->'contact'->>'city');
  v_phone      text := trim(payload->'contact'->>'phone');
  v_express    boolean := coalesce((payload->>'express')::boolean, false);
  v_payment    text := coalesce(payload->>'payment', 'cod');
  v_items      integer := 0;
  v_delivery   integer := 0;
  v_grand      integer := 0;
  r            record;
  v_ship_id    uuid;
  v_ship_items integer;
  v_ship_fee   integer;
begin
  if jsonb_array_length(coalesce(payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'empty order' using errcode = 'check_violation';
  end if;

  -- Read what was asked for, and lock those product rows for the rest of the
  -- transaction so two buyers cannot both take the last one.
  create temp table _want on commit drop as
  select (l->>'product_id')::uuid as product_id,
         least(greatest((l->>'qty')::int, 1), 10) as qty
  from jsonb_array_elements(payload->'lines') l;

  create temp table _lines on commit drop as
  select p.id as product_id, p.seller_id, p.title, p.price, p.stock, s.city as seller_city, w.qty
  from _want w
  join products p on p.id = w.product_id
  join sellers  s on s.id = p.seller_id
  where p.status = 'live' and s.status = 'active'
  for no key update of p;

  if (select count(*) from _lines) <> (select count(*) from _want) then
    raise exception 'a listing is no longer available' using errcode = 'no_data_found';
  end if;

  if exists (select 1 from _lines where qty > stock) then
    raise exception 'not enough stock' using errcode = 'check_violation';
  end if;

  select coalesce(sum(price * qty), 0) into v_items from _lines;

  -- Delivery is worked out per seller, because each seller ships their own
  -- parcel. Free delivery is therefore EARNED PER SELLER, never across the bag:
  -- a Rs 6,000 order split between three sellers has earned it from none of them.
  select coalesce(sum(delivery_fee(seller_city, v_city, seller_items, v_express)), 0)
    into v_delivery
  from (
    select seller_city, sum(price * qty)::int as seller_items
    from _lines group by seller_id, seller_city
  ) per_seller;

  v_grand := v_items + v_delivery;

  -- What a rider can be asked to carry back.
  if v_payment = 'cod' and v_grand > 50000 then
    raise exception 'cash on delivery is not available above Rs 50,000' using errcode = 'check_violation';
  end if;

  v_code := new_order_code();

  insert into orders (code, buyer_name, buyer_phone, city, area, address, landmark, notes,
                      express, payment, items_total, delivery_total, grand_total)
  values (v_code,
          trim(payload->'contact'->>'name'), v_phone, v_city,
          trim(payload->'contact'->>'area'), trim(payload->'contact'->>'address'),
          coalesce(trim(payload->'contact'->>'landmark'), ''),
          coalesce(trim(payload->'contact'->>'notes'), ''),
          v_express, v_payment, v_items, v_delivery, v_grand)
  returning id into v_order_id;

  for r in
    select seller_id, max(seller_city) as seller_city, sum(price * qty)::int as items
    from _lines group by seller_id
  loop
    v_ship_items := r.items;
    v_ship_fee   := delivery_fee(r.seller_city, v_city, v_ship_items, v_express);

    insert into shipments (order_id, seller_id, items_total, delivery, total)
    values (v_order_id, r.seller_id, v_ship_items, v_ship_fee, v_ship_items + v_ship_fee)
    returning id into v_ship_id;

    insert into shipment_lines (shipment_id, product_id, title, price, qty)
    select v_ship_id, product_id, title, price, qty from _lines where seller_id = r.seller_id;
  end loop;

  -- Only now, once everything else has succeeded.
  update products p set stock = p.stock - l.qty
  from _lines l where p.id = l.product_id;

  update products set status = 'sold' where stock = 0 and status = 'live'
    and id in (select product_id from _lines);

  return get_order(v_code, v_phone);
end $$;

-- Reading an order back. The code alone is not enough: a guessed or
-- shoulder-surfed code returns nothing without the phone it was placed with.
create or replace function public.get_order(p_code text, p_phone text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'code', o.code,
    'placed_at', o.placed_at,
    'express', o.express,
    'payment', o.payment,
    'contact', jsonb_build_object(
      'name', o.buyer_name, 'phone', o.buyer_phone, 'city', o.city,
      'area', o.area, 'address', o.address, 'landmark', o.landmark, 'notes', o.notes),
    'totals', jsonb_build_object(
      'items', o.items_total, 'delivery', o.delivery_total, 'total', o.grand_total,
      'units', (select coalesce(sum(sl.qty), 0) from shipments sh
                join shipment_lines sl on sl.shipment_id = sh.id where sh.order_id = o.id)),
    'shipments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seller_id', sh.seller_id, 'seller', s.brand_name, 'from', s.city,
        'status', sh.status, 'items', sh.items_total, 'delivery', sh.delivery,
        'total', sh.total, 'collected_by', sh.collected_by,
        'lines', (select jsonb_agg(jsonb_build_object('id', sl.product_id, 'title', sl.title,
                                                      'price', sl.price, 'qty', sl.qty) order by sl.title)
                  from shipment_lines sl where sl.shipment_id = sh.id)
      ) order by s.brand_name), '[]'::jsonb)
      from shipments sh join sellers s on s.id = sh.seller_id where sh.order_id = o.id)
  )
  from orders o
  where o.code = upper(trim(p_code)) and o.buyer_phone = trim(p_phone);
$$;

revoke all on function public.place_order(jsonb) from public;
revoke all on function public.get_order(text, text) from public;
grant execute on function public.place_order(jsonb) to anon, authenticated;
grant execute on function public.get_order(text, text) to anon, authenticated;
