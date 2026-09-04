-- Reads and checkout, now that a listing can have sizes, a sale price and a
-- delivery estimate — and orders can be cancelled.

alter table shipment_lines add column variant_id uuid references variants(id);
alter table shipment_lines add column variant_label text;

-- Drop the previous signatures before redefining these with extra parameters.
-- `create or replace` cannot change an argument list, so adding defaults makes
-- an OVERLOAD rather than a replacement — and then every existing call becomes
-- "function is not unique" and fails. The old shapes have to go.
drop function if exists public.browse(text, int, int);
drop function if exists public.set_shipment_status(uuid, text);

-- ------------------------------------------------------------ the shape ----
create or replace function public.product_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description,
    'price', effective_price(p),
    -- The number it used to be, only when there is a live sale. The card shows
    -- a strikethrough off this and nothing else, so an expired sale simply
    -- stops being one everywhere at once.
    'was', case when effective_price(p) < p.price then p.price else null end,
    'sale_ends_at', case when effective_price(p) < p.price then p.sale_ends_at else null end,
    'interest', p.interest, 'tags', to_jsonb(p.tags), 'condition', p.condition,
    'stock', available_stock(p.id),
    'city', p.city, 'status', p.status, 'promoted', p.promoted,
    'created_at', p.created_at, 'seller_id', p.seller_id,
    'variants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'size', v.size, 'colour', v.colour,
        'colour_hex', v.colour_hex, 'stock', v.stock) order by v.position, v.size, v.colour)
      from variants v where v.product_id = p.id), '[]'::jsonb),
    'sizes',   coalesce((select jsonb_agg(distinct v.size)   from variants v where v.product_id = p.id and v.size is not null), '[]'::jsonb),
    'colours', coalesce((select jsonb_agg(distinct jsonb_build_object('name', v.colour, 'hex', v.colour_hex))
                         from variants v where v.product_id = p.id and v.colour is not null), '[]'::jsonb),
    'seller', jsonb_build_object(
      'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'since', s.created_at,
      'dispatch_days', s.dispatch_days,
      'delivered', (select count(*) from shipments sh where sh.seller_id = s.id and sh.status = 'delivered'),
      'rating', (select round(avg(r.rating)::numeric, 1) from reviews r where r.seller_id = s.id),
      'reviews', (select count(*) from reviews r where r.seller_id = s.id)),
    'rating',  (select round(avg(r.rating)::numeric, 1) from reviews r where r.product_id = p.id),
    'reviews', (select count(*) from reviews r where r.product_id = p.id),
    'photo_keys', coalesce((select jsonb_agg(ph.key order by ph.position)
                            from photos ph where ph.product_id = p.id), '[]'::jsonb)
  )
  from products p join sellers s on s.id = p.seller_id
  where p_id = p.id and p.status = 'live' and s.status = 'active';
$$;

/* Reviews for a listing, newest first — shown under the product. */
create or replace function public.product_reviews(p_product uuid, p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'rating', r.rating, 'body', r.body, 'by', r.buyer_name, 'at', r.created_at
  ) order by r.created_at desc), '[]'::jsonb)
  from (select * from reviews where product_id = p_product
         order by created_at desc limit greatest(1, least(p_limit, 50))) r;
$$;
grant execute on function public.product_reviews(uuid, int) to anon, authenticated;

-- ------------------------------------------------------------- browsing ----
-- Filters, because Vinted's whole browse experience is filtering and ours was a
-- single category chip. `sort` last: a buyer who has narrowed to four items
-- does not need to sort them.
create or replace function public.browse(
  p_interest text default null,
  p_limit int default 60,
  p_offset int default 0,
  p_min_price int default null,
  p_max_price int default null,
  p_city text default null,
  p_condition text default null,
  p_size text default null,
  p_on_sale boolean default false,
  p_sort text default 'new'
) returns jsonb
language sql stable security definer set search_path = public as $$
  with matching as (
    select p.id, p.created_at, p.promoted, effective_price(p) as price
      from products p join sellers s on s.id = p.seller_id
     where p.status = 'live' and s.status = 'active'
       and exists (select 1 from photos ph where ph.product_id = p.id)
       and (p_interest  is null or p.interest = p_interest)
       and (p_city      is null or lower(p.city) = lower(p_city))
       and (p_condition is null or p.condition = p_condition)
       and (p_min_price is null or effective_price(p) >= p_min_price)
       and (p_max_price is null or effective_price(p) <= p_max_price)
       and (not p_on_sale or effective_price(p) < p.price)
       and (p_size is null or exists (
             select 1 from variants v where v.product_id = p.id and v.size = p_size and v.stock > 0))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(product_json(t.id) order by t.ord) from (
        select id, row_number() over (order by
          case when p_sort = 'cheap' then price end asc,
          case when p_sort = 'dear'  then price end desc,
          promoted desc, created_at desc) as ord
        from matching
        order by ord
        limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) t), '[]'::jsonb),
    'total', (select count(*) from matching),
    -- What is actually available to filter by, so the UI never offers a filter
    -- that returns nothing.
    'facets', jsonb_build_object(
      'cities', coalesce((select jsonb_agg(distinct p.city) from products p join sellers s on s.id = p.seller_id
                           where p.status='live' and s.status='active'), '[]'::jsonb),
      'sizes',  coalesce((select jsonb_agg(distinct v.size) from variants v join products p on p.id = v.product_id
                           where p.status='live' and v.size is not null and v.stock > 0), '[]'::jsonb),
      'max_price', (select coalesce(max(price), 0) from matching)));
$$;
grant execute on function public.browse(text,int,int,int,int,text,text,text,boolean,text) to anon, authenticated;

/* The offers feed. Its own tab because a sale is a reason to come back, and the
   original idea note asked for exactly this: "dive through the best offers". */
create or replace function public.offers(p_limit int default 60) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(product_json(t.id) order by t.cut desc) from (
      select p.id, (p.price - effective_price(p))::numeric / p.price as cut
        from products p join sellers s on s.id = p.seller_id
       where p.status = 'live' and s.status = 'active'
         and exists (select 1 from photos ph where ph.product_id = p.id)
         and effective_price(p) < p.price
       order by cut desc limit greatest(1, least(p_limit, 100))) t), '[]'::jsonb));
$$;
grant execute on function public.offers(int) to anon, authenticated;

-- ------------------------------------------------------------- checkout ----
/* place_order, now variant-aware.
 *
 * A line names a variant when the listing has them. Stock is decremented on the
 * variant, not the product, and the size and colour are written onto the order
 * line as text — because the buyer must be able to read "Medium / Indigo" on
 * their order a year after the seller deleted that variant.
 */
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

  -- A listing with variants must be ordered by variant. Otherwise "one kurta"
  -- means nothing to the person packing it.
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

  insert into orders (code, buyer_name, buyer_phone, city, area, address, landmark, notes,
                      express, payment, items_total, delivery_total, grand_total)
  values (v_code, trim(payload->'contact'->>'name'), v_phone, v_city,
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

/* get_order gains the variant label, tracking, cancellation and the estimate. */
create or replace function public.get_order(p_code text, p_phone text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', o.code, 'placed_at', o.placed_at, 'express', o.express,
    'payment', o.payment, 'cancelled_at', o.cancelled_at,
    'cancel', cancel_window(o.code, o.buyer_phone),
    'contact', jsonb_build_object('name', o.buyer_name, 'phone', o.buyer_phone,
      'city', o.city, 'area', o.area, 'address', o.address,
      'landmark', o.landmark, 'notes', o.notes),
    'totals', jsonb_build_object('items', o.items_total, 'delivery', o.delivery_total,
      'total', o.grand_total,
      'units', (select coalesce(sum(sl.qty), 0) from shipments sh
                 join shipment_lines sl on sl.shipment_id = sh.id where sh.order_id = o.id)),
    'shipments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sh.id, 'seller_id', sh.seller_id, 'seller', s.brand_name, 'from', s.city,
        'status', sh.status, 'items', sh.items_total, 'delivery', sh.delivery,
        'total', sh.total, 'collected_by', sh.collected_by,
        'courier', sh.courier, 'tracking_number', sh.tracking_number,
        'dispatched_at', sh.dispatched_at, 'delivered_at', sh.delivered_at,
        'eta', delivery_estimate(s.city, o.city, s.dispatch_days, o.express),
        'lines', (select jsonb_agg(jsonb_build_object('id', sl.product_id, 'title', sl.title,
                    'variant', sl.variant_label, 'price', sl.price, 'qty', sl.qty) order by sl.title)
                  from shipment_lines sl where sl.shipment_id = sh.id)
      ) order by s.brand_name), '[]'::jsonb)
      from shipments sh join sellers s on s.id = sh.seller_id where sh.order_id = o.id)
  )
  from orders o
  where o.code = upper(trim(p_code)) and o.buyer_phone = trim(p_phone);
$$;

/* The seller's inbox gains the same. */
create or replace function public.my_shipments() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'placed_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', sh.id, 'code', o.code, 'placed_at', o.placed_at, 'status', sh.status,
      'payment', o.payment, 'express', o.express, 'cancelled_at', o.cancelled_at,
      'items_total', sh.items_total, 'delivery', sh.delivery, 'total', sh.total,
      'courier', sh.courier, 'tracking_number', sh.tracking_number,
      'buyer', jsonb_build_object('name', o.buyer_name, 'phone', o.buyer_phone,
        'city', o.city, 'area', o.area, 'address', o.address,
        'landmark', o.landmark, 'notes', o.notes),
      'lines', (select jsonb_agg(jsonb_build_object('title', sl.title, 'variant', sl.variant_label,
                  'price', sl.price, 'qty', sl.qty) order by sl.title)
                from shipment_lines sl where sl.shipment_id = sh.id)
    ) as x
    from shipments sh join orders o on o.id = sh.order_id
    where sh.seller_id = my_seller_id()) t;
$$;
