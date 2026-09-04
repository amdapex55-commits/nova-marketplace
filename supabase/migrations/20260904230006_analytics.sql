-- Measuring what people actually do.
--
-- Two tables on purpose. `product_stats` stays what it is — per product, per
-- day, the numbers a seller is shown. `site_stats` is everything that is not
-- about one product: which screens people open, where they stop, bags they fill
-- and abandon, searches that found nothing. That belongs to whoever runs the
-- marketplace, not to a seller.
--
-- Both are counters, never a log. One row per thing per day. A row per event is
-- millions of writes a month on a 500 MB database, and nobody ever reads an
-- individual event anyway.

create table site_stats (
  day    date not null default current_date,
  metric text not null,
  detail text not null default '',
  n      integer not null default 0,
  primary key (day, metric, detail)
);
alter table site_stats enable row level security;

/* Which metrics exist is fixed here rather than accepted from the client. A
   client that can invent metric names can fill the table with rubbish, and a
   dashboard of rubbish is worse than no dashboard. */
create or replace function public.record_site(events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_rows int;
begin
  if jsonb_array_length(coalesce(events, '[]'::jsonb)) = 0 then return 0; end if;

  insert into site_stats (day, metric, detail, n)
  select current_date, e->>'metric', left(coalesce(e->>'detail', ''), 60), count(*)::int
    from jsonb_array_elements(events) e
   where e->>'metric' in (
     'screen','search_empty','search_ok','filter_used','category_used','banner_click',
     'bag_add','bag_remove','bag_abandon','checkout_start','checkout_field_error',
     'checkout_abandon','order_placed','order_cancelled','signup_start','signup_done',
     'gate_seen','gate_cancelled','share','report','message_sent','deck_loop','stall')
   group by 1, 2, 3
  on conflict (day, metric, detail) do update set n = site_stats.n + excluded.n;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;
grant execute on function public.record_site(jsonb) to anon, authenticated;

/* Everything, for whoever runs the place. */
create or replace function public.admin_analytics(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_since date := current_date - greatest(1, least(p_days, 90));
begin
  perform require_admin();
  return jsonb_build_object(
    'days', greatest(1, least(p_days, 90)),
    'totals', (
      select coalesce(jsonb_object_agg(metric, n), '{}'::jsonb)
      from (select metric, sum(n)::int as n from site_stats where day >= v_since group by metric) t),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'metric', d.metric, 'n', d.n)
                                         order by d.day)
      from (select day, metric, sum(n)::int as n from site_stats
             where day >= v_since and metric in ('screen','order_placed','bag_add','signup_done')
             group by day, metric) d), '[]'::jsonb),
    'screens', coalesce((select jsonb_agg(jsonb_build_object('name', detail, 'n', n) order by n desc)
      from (select detail, sum(n)::int as n from site_stats
             where day >= v_since and metric = 'screen' group by detail order by n desc limit 12) s), '[]'::jsonb),
    -- Searches that found nothing are the most actionable thing here: each one
    -- is somebody who wanted to buy something we do not stock.
    'empty_searches', coalesce((select jsonb_agg(jsonb_build_object('q', detail, 'n', n) order by n desc)
      from (select detail, sum(n)::int as n from site_stats
             where day >= v_since and metric = 'search_empty' and detail <> ''
             group by detail order by n desc limit 15) e), '[]'::jsonb),
    'funnel', jsonb_build_object(
      'bag_add',        (select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='bag_add'),
      'gate_seen',      (select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='gate_seen'),
      'gate_cancelled', (select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='gate_cancelled'),
      'signup_done',    (select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='signup_done'),
      'checkout_start', (select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='checkout_start'),
      'checkout_abandon',(select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='checkout_abandon'),
      'order_placed',   (select coalesce(sum(n),0)::int from site_stats where day >= v_since and metric='order_placed')),
    'live', jsonb_build_object(
      'bags_open',   (select count(*) from buyers b where exists (
                        select 1 from orders o where o.user_id = b.user_id) is not true),
      'orders_today',(select count(*) from orders where placed_at >= current_date),
      'gmv_today',   (select coalesce(sum(grand_total),0) from orders where placed_at >= current_date),
      'cancel_rate', (select case when count(*) = 0 then null else
                        round(100.0 * count(*) filter (where cancelled_at is not null) / count(*)) end
                      from orders where placed_at >= v_since)),
    'refs', ref_exhausted());
end $$;
grant execute on function public.admin_analytics(int) to authenticated;
