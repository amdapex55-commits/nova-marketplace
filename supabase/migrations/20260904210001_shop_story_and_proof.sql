-- What a shop page needs to feel like a shop, and what a seller needs to see to
-- believe the money is coming.

alter table sellers add column story text not null default '';
alter table sellers add column cover_key text;
alter table sellers add column founder boolean not null default false;
alter table sellers add column founder_no integer;

/* Founder spots.
 *
 * A scarcity claim is only worth making if it is real, so this counts and caps
 * rather than decorating. The number is assigned when a shop is APPROVED, not
 * when it signs up — otherwise a spot is taken by somebody who never opened.
 * Once FOUNDER_SPOTS approvals have happened there are no more, ever.
 */
create or replace function public.founder_spots() returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'total', 50,
    'taken', (select count(*) from sellers where founder),
    'left', greatest(0, 50 - (select count(*) from sellers where founder)));
$$;
grant execute on function public.founder_spots() to anon, authenticated;

create or replace function public.admin_set_seller_status(p_seller uuid, p_status text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare v_taken int;
begin
  perform require_admin();
  if p_status not in ('pending','active','suspended') then
    raise exception 'not a seller status' using errcode = 'check_violation';
  end if;
  update sellers set status = p_status where id = p_seller;
  if not found then raise exception 'no such seller' using errcode = 'no_data_found'; end if;

  if p_status = 'active' then
    -- The founder number is claimed here, once, and never reassigned.
    select count(*) into v_taken from sellers where founder;
    if v_taken < 50 and not (select founder from sellers where id = p_seller) then
      update sellers set founder = true, founder_no = v_taken + 1 where id = p_seller;
    end if;

    update products set status = 'live'
     where seller_id = p_seller and status = 'pending' and stock > 0
       and exists (select 1 from photos ph where ph.product_id = products.id);
  elsif p_status = 'suspended' then
    update products set status = 'pending' where seller_id = p_seller and status = 'live';
  end if;

  return (select jsonb_build_object('id', id, 'status', status, 'founder_no', founder_no,
            'released', (select count(*) from products where seller_id = p_seller and status = 'live'))
          from sellers where id = p_seller);
end $$;

/* The shop page. A page with a name and a grid is a search result; a page with
   a story, a face and a promise is a shop. */
create or replace function public.shop(p_seller uuid, p_limit int default 60) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when s.id is null then null else jsonb_build_object(
    'id', s.id, 'brand_name', s.brand_name, 'city', s.city,
    'since', s.created_at, 'dispatch_days', s.dispatch_days,
    'story', s.story, 'cover_key', s.cover_key,
    'founder', s.founder, 'founder_no', s.founder_no,
    'delivered', (select count(*) from shipments sh where sh.seller_id = s.id and sh.status = 'delivered'),
    'rating', (select round(avg(r.rating)::numeric, 1) from reviews r where r.seller_id = s.id),
    'reviews', (select count(*) from reviews r where r.seller_id = s.id),
    'live', (select count(*) from products p where p.seller_id = s.id and p.status = 'live'),
    -- A promise the seller has actually kept, or nothing. "Usually ships in 2
    -- days" from a shop that has never shipped is a claim, not a promise.
    'on_time', (select case when count(*) < 3 then null else
                  round(100.0 * count(*) filter (
                    where sh.delivered_at is not null
                      and sh.delivered_at <= sh.order_placed + make_interval(days => s.dispatch_days + 5)) / count(*))
                end
                from (select sh.*, o.placed_at as order_placed
                        from shipments sh join orders o on o.id = sh.order_id
                       where sh.seller_id = s.id and sh.status = 'delivered') sh),
    'latest_reviews', coalesce((select jsonb_agg(jsonb_build_object(
        'rating', r.rating, 'body', r.body, 'by', r.buyer_name, 'at', r.created_at,
        'product', (select p.title from products p where p.id = r.product_id)))
      from (select * from reviews where seller_id = s.id order by created_at desc limit 6) r), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(product_json(p.id) order by p.promoted desc, p.created_at desc)
                          from (select id, promoted, created_at from products
                                 where seller_id = s.id and status = 'live'
                                 order by promoted desc, created_at desc
                                 limit greatest(1, least(p_limit, 100))) p), '[]'::jsonb))
  end
  from sellers s where s.id = p_seller and s.status = 'active';
$$;

/* Sellers write their own story and set a cover. */
create or replace function public.update_story(p_story text, p_cover text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := my_seller_id();
begin
  if v_id is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  update sellers set story = left(coalesce(p_story, ''), 900),
                     cover_key = coalesce(nullif(trim(p_cover), ''), cover_key)
   where id = v_id;
  return me();
end $$;
grant execute on function public.update_story(text, text) to authenticated;

/* me() carries the story and the founder badge so the workspace can show both. */
create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when s.id is null then null else jsonb_build_object(
    'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'status', s.status,
    'plan', s.plan, 'trial_ends_at', s.trial_ends_at, 'dispatch_days', s.dispatch_days,
    'story', s.story, 'cover_key', s.cover_key,
    'founder', s.founder, 'founder_no', s.founder_no,
    'owner_name', c.owner_name, 'phone', c.phone, 'address', c.address,
    'products', (select count(*) from products p where p.seller_id = s.id),
    'live_products', (select count(*) from products p where p.seller_id = s.id and p.status = 'live'),
    'open_orders', (select count(*) from shipments sh
                    where sh.seller_id = s.id and sh.status in ('placed','confirmed')),
    'unread_messages', (select coalesce(sum(t.seller_unread), 0) from threads t where t.seller_id = s.id)
  ) end
  from seller_contacts c join sellers s on s.id = c.seller_id
  where c.user_id = auth.uid();
$$;

/* Insights, as a funnel with the rates worked out.
 *
 * A seller looking at "412 views" cannot tell whether that is good. A seller
 * looking at "412 seen → 38 saved (9%) → 11 bagged → 4 ordered (1.0%)" knows
 * exactly which step is leaking, which is the only reason to show numbers at
 * all. */
create or replace function public.my_insights(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_seller uuid := my_seller_id(); v_since date := current_date - greatest(1, least(p_days, 90));
begin
  if v_seller is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'days', greatest(1, least(p_days, 90)),
    'funnel', (
      select jsonb_build_object(
        'seen',    coalesce(sum(st.impressions), 0),
        'saved',   coalesce(sum(st.keeps), 0),
        'opened',  coalesce(sum(st.detail_views), 0),
        'bagged',  coalesce(sum(st.adds), 0),
        'ordered', (select coalesce(sum(sl.qty), 0) from shipment_lines sl
                     join shipments sh on sh.id = sl.shipment_id
                    where sh.seller_id = v_seller and sh.status <> 'cancelled'
                      and sh.id in (select id from shipments where seller_id = v_seller)),
        'earned',  (select coalesce(sum(sh.items_total), 0) from shipments sh
                     where sh.seller_id = v_seller and sh.status = 'delivered'),
        'pending', (select coalesce(sum(sh.items_total), 0) from shipments sh
                     where sh.seller_id = v_seller and sh.status in ('placed','confirmed','dispatched')))
      from product_stats st join products p on p.id = st.product_id
      where p.seller_id = v_seller and st.day >= v_since),
    'products', coalesce((
      select jsonb_agg(x order by (x->>'impressions')::int desc) from (
        select jsonb_build_object(
          'id', p.id, 'title', p.title, 'status', p.status, 'promoted', p.promoted,
          'impressions', coalesce(sum(st.impressions), 0),
          'keeps',       coalesce(sum(st.keeps), 0),
          'detail_views',coalesce(sum(st.detail_views), 0),
          'adds',        coalesce(sum(st.adds), 0),
          'ordered',     (select coalesce(sum(sl.qty), 0) from shipment_lines sl
                           join shipments sh on sh.id = sl.shipment_id
                          where sl.product_id = p.id and sh.status <> 'cancelled'),
          'photo_key',   (select ph.key from photos ph where ph.product_id = p.id order by ph.position limit 1)
        ) as x
        from products p
        left join product_stats st on st.product_id = p.id and st.day >= v_since
        where p.seller_id = v_seller
        group by p.id, p.title, p.status, p.promoted) t), '[]'::jsonb));
end $$;
