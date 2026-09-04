-- Cancelling, tracking, reviews, and a shop's own page.

-- ------------------------------------------------------------ tracking -----
alter table shipments add column courier text;
alter table shipments add column tracking_number text;
alter table shipments add column dispatched_at timestamptz;
alter table shipments add column delivered_at  timestamptz;
alter table shipments add column cancelled_at  timestamptz;

-- ---------------------------------------------------------- cancelling -----
alter table orders add column cancelled_at timestamptz;

/* One hour short of a day would be a support ticket, so the window is exactly
   24 hours from when the order was placed — and it closes early if the seller
   has already handed the parcel over, because a parcel in a van cannot be
   un-sent. Both facts are returned so the buyer is told WHICH one closed it
   rather than just losing the button. */
create or replace function public.cancel_window(p_code text, p_phone text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'expires_at', o.placed_at + interval '24 hours',
    'seconds_left', greatest(0, extract(epoch from (o.placed_at + interval '24 hours' - now()))::int),
    'dispatched', exists (select 1 from shipments sh where sh.order_id = o.id
                           and sh.status in ('dispatched','delivered')),
    'cancelled', o.cancelled_at is not null,
    'can_cancel', o.cancelled_at is null
      and now() < o.placed_at + interval '24 hours'
      and not exists (select 1 from shipments sh where sh.order_id = o.id
                       and sh.status in ('dispatched','delivered')))
  from orders o
  where o.code = upper(trim(p_code)) and o.buyer_phone = trim(p_phone);
$$;

create or replace function public.cancel_order(p_code text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_win jsonb;
begin
  select id into v_order from orders
   where code = upper(trim(p_code)) and buyer_phone = trim(p_phone);
  if v_order is null then raise exception 'no such order' using errcode = 'no_data_found'; end if;

  v_win := cancel_window(p_code, p_phone);
  if not (v_win->>'can_cancel')::boolean then
    if (v_win->>'cancelled')::boolean then
      raise exception 'this order is already cancelled' using errcode = 'check_violation';
    elsif (v_win->>'dispatched')::boolean then
      raise exception 'a parcel is already on its way — refuse it at the door instead'
        using errcode = 'check_violation';
    else
      raise exception 'the 24 hour window for cancelling has passed'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Stock goes back before anything else, so a cancelled order cannot leave a
  -- listing showing as sold out.
  update variants v set stock = v.stock + sl.qty
    from shipment_lines sl join shipments sh on sh.id = sl.shipment_id
   where sh.order_id = v_order and sl.variant_id = v.id;

  update products p set stock = p.stock + sl.qty, status = case when p.status = 'sold' then 'live' else p.status end
    from shipment_lines sl join shipments sh on sh.id = sl.shipment_id
   where sh.order_id = v_order and sl.variant_id is null and p.id = sl.product_id;

  update shipments set status = 'cancelled', cancelled_at = now() where order_id = v_order;
  update orders set cancelled_at = now() where id = v_order;

  return get_order(p_code, p_phone);
end $$;

/* The seller's side now records when, and by which courier. */
create or replace function public.set_shipment_status(
  p_shipment uuid, p_status text, p_courier text default null, p_tracking text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  if p_status not in ('confirmed','dispatched','delivered','refused') then
    raise exception 'not a status a seller can set' using errcode = 'check_violation';
  end if;
  select status into v_current from shipments where id = p_shipment and seller_id = my_seller_id();
  if not found then raise exception 'not your parcel' using errcode = 'insufficient_privilege'; end if;
  if v_current in ('delivered','refused','cancelled') then
    raise exception 'this parcel is already closed' using errcode = 'check_violation';
  end if;
  -- A buyer who cancelled inside the window must not then be shipped to.
  if v_current = 'cancelled' then
    raise exception 'the buyer cancelled this order' using errcode = 'check_violation';
  end if;

  update shipments set
    status = p_status,
    courier = coalesce(nullif(trim(p_courier), ''), courier),
    tracking_number = coalesce(nullif(trim(p_tracking), ''), tracking_number),
    dispatched_at = case when p_status = 'dispatched' then now() else dispatched_at end,
    delivered_at  = case when p_status = 'delivered'  then now() else delivered_at  end
  where id = p_shipment;
  return p_status;
end $$;

grant execute on function public.cancel_window(text, text) to anon, authenticated;
grant execute on function public.cancel_order(text, text)  to anon, authenticated;
grant execute on function public.set_shipment_status(uuid, text, text, text) to authenticated;

-- ------------------------------------------------------------- reviews -----
-- Only after a parcel has actually been delivered, and once per order per
-- listing. Etsy's rule of thumb is the right one: a review is evidence of a
-- transaction, not an opinion anybody can leave.
create table reviews (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  seller_id  uuid not null references sellers(id) on delete cascade,
  order_code text not null,
  device_id  text not null,
  buyer_name text not null default 'Buyer',
  rating     smallint not null check (rating between 1 and 5),
  body       text not null default '' check (length(body) <= 700),
  created_at timestamptz not null default now(),
  unique (order_code, product_id)
);
create index reviews_product on reviews (product_id, created_at desc);
create index reviews_seller  on reviews (seller_id, created_at desc);
alter table reviews enable row level security;
grant select on reviews to anon, authenticated;
create policy reviews_are_public on reviews for select to anon, authenticated using (true);

create or replace function public.leave_review(
  p_code text, p_phone text, p_product uuid, p_rating int, p_body text default ''
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order orders; v_seller uuid;
begin
  select * into v_order from orders where code = upper(trim(p_code)) and buyer_phone = trim(p_phone);
  if not found then raise exception 'no such order' using errcode = 'no_data_found'; end if;

  select sh.seller_id into v_seller
    from shipments sh join shipment_lines sl on sl.shipment_id = sh.id
   where sh.order_id = v_order.id and sl.product_id = p_product and sh.status = 'delivered'
   limit 1;
  if v_seller is null then
    raise exception 'you can review this once it has been delivered' using errcode = 'check_violation';
  end if;

  insert into reviews (product_id, seller_id, order_code, device_id, buyer_name, rating, body)
  values (p_product, v_seller, v_order.code, coalesce(v_order.buyer_phone, ''),
          split_part(v_order.buyer_name, ' ', 1),
          greatest(1, least(5, p_rating)), left(coalesce(p_body, ''), 700))
  on conflict (order_code, product_id) do update
    set rating = excluded.rating, body = excluded.body, created_at = now();

  return jsonb_build_object('ok', true);
end $$;

create or replace function public.reviewable(p_code text, p_phone text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', sl.product_id, 'title', sl.title,
    'reviewed', exists (select 1 from reviews r where r.order_code = o.code and r.product_id = sl.product_id),
    'rating', (select r.rating from reviews r where r.order_code = o.code and r.product_id = sl.product_id)
  )), '[]'::jsonb)
  from orders o
  join shipments sh on sh.order_id = o.id and sh.status = 'delivered'
  join shipment_lines sl on sl.shipment_id = sh.id
  where o.code = upper(trim(p_code)) and o.buyer_phone = trim(p_phone);
$$;

grant execute on function public.leave_review(text, text, uuid, int, text) to anon, authenticated;
grant execute on function public.reviewable(text, text) to anon, authenticated;

-- --------------------------------------------------------- the shop page ---
/* A shop's own page, and the reason it exists: a seller can send their own
   Instagram following to a link that is theirs. That is the whole acquisition
   plan when the ad budget is zero. */
create or replace function public.shop(p_seller uuid, p_limit int default 60) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when s.id is null then null else jsonb_build_object(
    'id', s.id, 'brand_name', s.brand_name, 'city', s.city,
    'since', s.created_at, 'dispatch_days', s.dispatch_days,
    'delivered', (select count(*) from shipments sh where sh.seller_id = s.id and sh.status = 'delivered'),
    'rating', (select round(avg(r.rating)::numeric, 1) from reviews r where r.seller_id = s.id),
    'reviews', (select count(*) from reviews r where r.seller_id = s.id),
    'live', (select count(*) from products p where p.seller_id = s.id and p.status = 'live'),
    'products', coalesce((select jsonb_agg(product_json(p.id) order by p.promoted desc, p.created_at desc)
                          from (select id, promoted, created_at from products
                                 where seller_id = s.id and status = 'live'
                                 order by promoted desc, created_at desc
                                 limit greatest(1, least(p_limit, 100))) p), '[]'::jsonb))
  end
  from sellers s where s.id = p_seller and s.status = 'active';
$$;
grant execute on function public.shop(uuid, int) to anon, authenticated;
