-- Reporting a listing, and the numbers a seller is shown.

-- ------------------------------------------------------------- reports ------
-- The data model note listed a `reports` table but 0001 never created one, so
-- it is created here rather than altered. No grants for anyone: nobody reads it
-- through the API. Filing goes through a definer function so an anonymous buyer
-- can report a listing without being able to read anyone else's report.

create table reports (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  -- The buyer's device id from localStorage. Not a person, and not trusted —
  -- it exists to rate-limit and to collapse duplicates, nothing more.
  device_id  text not null,
  reason     text not null,
  detail     text not null default '',
  status     text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at timestamptz not null default now()
);

alter table reports enable row level security;
create index reports_open on reports (created_at desc) where status = 'open';
create index reports_product on reports (product_id);

create or replace function public.report_listing(
  p_product uuid, p_device text, p_reason text, p_detail text default ''
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_recent int;
begin
  if p_reason not in ('counterfeit','prohibited','misleading','offensive','scam','other') then
    raise exception 'not a reason we recognise' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from products where id = p_product) then
    raise exception 'no such listing' using errcode = 'no_data_found';
  end if;

  -- A device that has filed ten reports in an hour is not reporting, it is
  -- attacking a competitor. Cheap to check, and it keeps the queue workable.
  select count(*) into v_recent from reports
   where device_id = p_device and created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'too many reports from this device, try later' using errcode = 'check_violation';
  end if;

  -- One open report per device per listing: reporting twice is not two problems.
  if exists (select 1 from reports
              where product_id = p_product and device_id = p_device and status = 'open') then
    return jsonb_build_object('already', true);
  end if;

  insert into reports (product_id, device_id, reason, detail)
  values (p_product, p_device, p_reason, left(coalesce(p_detail, ''), 500));
  return jsonb_build_object('already', false);
end $$;

create or replace function public.admin_reports(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'reason', r.reason, 'detail', r.detail, 'status', r.status,
      'created_at', r.created_at, 'product_id', p.id, 'title', p.title,
      'product_status', p.status, 'seller', s.brand_name, 'seller_id', s.id,
      'others', (select count(*) from reports r2 where r2.product_id = p.id and r2.id <> r.id)
    ) order by r.created_at desc)
    from reports r join products p on p.id = r.product_id join sellers s on s.id = p.seller_id
    where p_status is null or r.status = p_status), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_report(p_report uuid, p_status text) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_status not in ('actioned','dismissed') then
    raise exception 'not a resolution' using errcode = 'check_violation';
  end if;
  update reports set status = p_status where id = p_report;
  if not found then raise exception 'no such report' using errcode = 'no_data_found'; end if;
  return p_status;
end $$;

-- --------------------------------------------------------------- stats ------
/* Recording what buyers did.
 *
 * One row per product per day, upserted. Never one row per view: an impression
 * per card per swipe is potentially millions of writes a month and a 500 MB
 * free-tier database will not take it — and the seller only ever sees the daily
 * number anyway. The client buffers and flushes in batches; this collapses a
 * batch into a handful of updates.
 */
create or replace function public.record_events(events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_rows int;
begin
  if jsonb_array_length(coalesce(events, '[]'::jsonb)) = 0 then return 0; end if;

  with counted as (
    select (e->>'product_id')::uuid as pid,
           e->>'type' as kind,
           count(*)::int as n
      from jsonb_array_elements(events) e
     where e ? 'product_id' and e ? 'type'
       and e->>'type' in ('impression','keep','detail','add_to_bag')
     group by 1, 2
  ), valid as (
    -- Ignore ids that are not live listings; a client can send anything.
    select c.* from counted c join products p on p.id = c.pid where p.status = 'live'
  )
  insert into product_stats (product_id, day, impressions, keeps, detail_views, adds)
  select pid, current_date,
         sum(case when kind = 'impression' then n else 0 end),
         sum(case when kind = 'keep'       then n else 0 end),
         sum(case when kind = 'detail'     then n else 0 end),
         sum(case when kind = 'add_to_bag' then n else 0 end)
    from valid group by pid
  on conflict (product_id, day) do update set
    impressions  = product_stats.impressions  + excluded.impressions,
    keeps        = product_stats.keeps        + excluded.keeps,
    detail_views = product_stats.detail_views + excluded.detail_views,
    adds         = product_stats.adds         + excluded.adds;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

/* What the seller is shown.
 *
 * This is the screen they look at on day 25 deciding whether to pay, so it
 * answers that question directly: how many people saw it, how many saved it,
 * how many ordered. Thirty days, per listing, plus a total. */
create or replace function public.my_insights(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_seller uuid := my_seller_id(); v_since date := current_date - greatest(1, least(p_days, 90));
begin
  if v_seller is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'days', greatest(1, least(p_days, 90)),
    'totals', (
      select jsonb_build_object(
        'impressions', coalesce(sum(st.impressions), 0),
        'keeps',       coalesce(sum(st.keeps), 0),
        'detail_views',coalesce(sum(st.detail_views), 0),
        'adds',        coalesce(sum(st.adds), 0),
        'orders',      (select count(*) from shipments sh where sh.seller_id = v_seller),
        'sold',        (select coalesce(sum(sh.items_total), 0) from shipments sh
                         where sh.seller_id = v_seller and sh.status <> 'refused'))
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
                          where sl.product_id = p.id and sh.status <> 'refused'),
          'photo_key',   (select ph.key from photos ph where ph.product_id = p.id order by ph.position limit 1)
        ) as x
        from products p
        left join product_stats st on st.product_id = p.id and st.day >= v_since
        where p.seller_id = v_seller
        group by p.id, p.title, p.status, p.promoted) t), '[]'::jsonb));
end $$;

revoke all on function public.report_listing(uuid, text, text, text) from public;
revoke all on function public.admin_reports(text)                    from public;
revoke all on function public.admin_resolve_report(uuid, text)       from public;
revoke all on function public.record_events(jsonb)                   from public;
revoke all on function public.my_insights(int)                       from public;

grant execute on function public.report_listing(uuid, text, text, text) to anon, authenticated;
grant execute on function public.record_events(jsonb)                   to anon, authenticated;
grant execute on function public.admin_reports(text)                    to authenticated;
grant execute on function public.admin_resolve_report(uuid, text)       to authenticated;
grant execute on function public.my_insights(int)                       to authenticated;
