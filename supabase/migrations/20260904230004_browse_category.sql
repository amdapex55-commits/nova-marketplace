-- browse gains a leaf-category filter.
drop function if exists public.browse(text,int,int,int,int,text,text,text,boolean,text);
create or replace function public.browse(
  p_interest text default null, p_limit int default 60, p_offset int default 0,
  p_min_price int default null, p_max_price int default null,
  p_city text default null, p_condition text default null, p_size text default null,
  p_on_sale boolean default false, p_sort text default 'new',
  p_category text default null
) returns jsonb
language sql stable security definer set search_path = public as $$
  with matching as (
    select p.id, p.created_at, p.promoted, effective_price(p) as price
      from products p join sellers s on s.id = p.seller_id
     where p.status = 'live' and s.status = 'active'
       and exists (select 1 from photos ph where ph.product_id = p.id)
       and (p_category is null or p.category = p_category)
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
        from matching order by ord
        limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) t), '[]'::jsonb),
    'total', (select count(*) from matching),
    'facets', jsonb_build_object(
      'cities', coalesce((select jsonb_agg(distinct p.city) from products p join sellers s on s.id = p.seller_id
                           where p.status='live' and s.status='active'), '[]'::jsonb),
      'sizes',  coalesce((select jsonb_agg(distinct v.size) from variants v join products p on p.id = v.product_id
                           where p.status='live' and v.size is not null and v.stock > 0), '[]'::jsonb),
      'max_price', (select coalesce(max(price), 0) from matching)));
$$;
grant execute on function public.browse(text,int,int,int,int,text,text,text,boolean,text,text) to anon, authenticated;
