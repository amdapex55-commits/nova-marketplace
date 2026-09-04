-- Banners, search suggestions, and "you might also like".

-- ----------------------------------------------------------- banners -------
-- Editable rows rather than hardcoded artwork: a banner is a merchandising
-- decision, and merchandising should not need a deploy.
create table banners (
  id         uuid primary key default gen_random_uuid(),
  headline   text not null,
  sub        text not null default '',
  cta        text not null default 'Have a look',
  -- Where it goes. A category slug, a seller, or a raw hash route.
  target     text not null,
  tone       text not null default 'emerald' check (tone in ('emerald','marigold','ink')),
  position   smallint not null default 0,
  live       boolean not null default true,
  starts_at  timestamptz,
  ends_at    timestamptz
);
alter table banners enable row level security;
grant select on banners to anon, authenticated;
create policy live_banners_are_public on banners
  for select to anon, authenticated
  using (live and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

create or replace function public.admin_banners() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((select jsonb_agg(to_jsonb(b) order by b.position, b.headline) from banners b), '[]'::jsonb);
end $$;

create or replace function public.admin_save_banner(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_admin();
  v_id := nullif(p->>'id','')::uuid;
  if v_id is null then
    insert into banners (headline, sub, cta, target, tone, position, live, ends_at)
    values (p->>'headline', coalesce(p->>'sub',''), coalesce(nullif(p->>'cta',''),'Have a look'),
            p->>'target', coalesce(nullif(p->>'tone',''),'emerald'),
            coalesce((p->>'position')::int, 0), coalesce((p->>'live')::boolean, true),
            nullif(p->>'ends_at','')::timestamptz)
    returning id into v_id;
  else
    update banners set
      headline = p->>'headline', sub = coalesce(p->>'sub',''),
      cta = coalesce(nullif(p->>'cta',''),'Have a look'), target = p->>'target',
      tone = coalesce(nullif(p->>'tone',''),'emerald'),
      position = coalesce((p->>'position')::int, position),
      live = coalesce((p->>'live')::boolean, live),
      ends_at = nullif(p->>'ends_at','')::timestamptz
    where id = v_id;
  end if;
  return (select to_jsonb(b) from banners b where b.id = v_id);
end $$;

create or replace function public.admin_delete_banner(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin perform require_admin(); delete from banners where id = p_id; end $$;

grant execute on function public.admin_banners()        to authenticated;
grant execute on function public.admin_save_banner(jsonb) to authenticated;
grant execute on function public.admin_delete_banner(uuid) to authenticated;

create or replace function public.banners_for(p_where text default 'browse') returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'headline', b.headline, 'sub', b.sub, 'cta', b.cta,
    'target', b.target, 'tone', b.tone) order by b.position), '[]'::jsonb)
  from banners b
  where b.live
    and (b.starts_at is null or b.starts_at <= now())
    and (b.ends_at is null or b.ends_at > now());
$$;
grant execute on function public.banners_for(text) to anon, authenticated;

-- -------------------------------------------------- search suggestions -----
/* What the search box offers before anything is typed, and while typing.
 *
 * Built from what is actually in the catalogue — categories that have stock,
 * shop names, and the words buyers have already searched for successfully —
 * so it can never suggest something that returns nothing. */
create table searches (
  q      text primary key,
  hits   integer not null default 0,
  found  integer not null default 0,
  last_at timestamptz not null default now()
);
alter table searches enable row level security;

create or replace function public.record_search(p_q text, p_found int) returns void
language plpgsql security definer set search_path = public as $$
declare v_q text := lower(btrim(p_q));
begin
  if length(v_q) < 2 or length(v_q) > 40 then return; end if;
  insert into searches (q, hits, found) values (v_q, 1, p_found)
  on conflict (q) do update set hits = searches.hits + 1, found = excluded.found, last_at = now();
end $$;
grant execute on function public.record_search(text, int) to anon, authenticated;

create or replace function public.search_suggestions(p_q text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    -- Before they type: the categories with the most stock, and the busiest
    -- searches that actually returned something.
    'popular', coalesce((select jsonb_agg(x) from (
        select c.label as x from categories c
         where c.parent is not null
           and (select count(*) from products p join sellers s on s.id = p.seller_id
                 where p.category = c.slug and p.status = 'live' and s.status = 'active') > 0
         order by (select count(*) from products p where p.category = c.slug and p.status = 'live') desc
         limit 6) t), '[]'::jsonb),
    'trending', coalesce((select jsonb_agg(q order by hits desc)
                          from (select q, hits from searches where found > 0 order by hits desc limit 5) t2), '[]'::jsonb),
    -- While they type: anything in the catalogue that starts with it.
    -- Each branch is parenthesised: a LIMIT inside a UNION arm is a syntax
    -- error without them, because the LIMIT would belong to the whole union.
    'matches', case when coalesce(length(btrim(p_q)), 0) < 2 then '[]'::jsonb else coalesce((
        select jsonb_agg(distinct m) from (
          (select p.title as m from products p join sellers s on s.id = p.seller_id
            where p.status = 'live' and s.status = 'active' and p.title ilike btrim(p_q) || '%' limit 5)
          union
          (select s.brand_name from sellers s
            where s.status = 'active' and s.brand_name ilike btrim(p_q) || '%' limit 3)
          union
          (select c.label from categories c where c.label ilike btrim(p_q) || '%' limit 3)
        ) u), '[]'::jsonb) end);
$$;
grant execute on function public.search_suggestions(text) to anon, authenticated;

-- ------------------------------------------------------------ related ------
/* "You might also like", kept short on purpose. Same category first, then the
   same shop — a wall of forty is a second browse page, not a suggestion. */
create or replace function public.related(p_product uuid, p_limit int default 6) returns jsonb
language sql stable security definer set search_path = public as $$
  with me as (select category, interest, seller_id, price from products where id = p_product)
  select coalesce(jsonb_agg(product_json(t.id) order by t.rank, t.gap), '[]'::jsonb)
  from (
    select p.id,
           case when p.category = (select category from me) then 0
                when p.seller_id = (select seller_id from me) then 1
                when p.interest = (select interest from me) then 2 else 3 end as rank,
           abs(effective_price(p) - (select price from me)) as gap
      from products p join sellers s on s.id = p.seller_id
     where p.status = 'live' and s.status = 'active' and p.id <> p_product
       and exists (select 1 from photos ph where ph.product_id = p.id)
       and (p.category = (select category from me)
         or p.seller_id = (select seller_id from me)
         or p.interest = (select interest from me))
     order by rank, gap
     limit greatest(1, least(p_limit, 12))) t;
$$;
grant execute on function public.related(uuid, int) to anon, authenticated;
