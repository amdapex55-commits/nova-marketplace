-- Suggestions match the start of any WORD, not the start of the title.
--
-- Prefix-matching the whole string meant "ku" suggested nothing, because the
-- product is called "Ajrak Block-Print Kurta" and nobody types the first word
-- of a title. \m is a word boundary, so "ku" now reaches "Kurta" wherever it
-- sits — which is how a person actually searches.
create or replace function public.search_suggestions(p_q text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with q as (select regexp_replace(btrim(coalesce(p_q, '')), '[^A-Za-z0-9 ]', '', 'g') as term)
  select jsonb_build_object(
    'popular', coalesce((select jsonb_agg(x) from (
        select c.label as x from categories c
         where c.parent is not null
           and (select count(*) from products p join sellers s on s.id = p.seller_id
                 where p.category = c.slug and p.status = 'live' and s.status = 'active') > 0
         order by (select count(*) from products p where p.category = c.slug and p.status = 'live') desc
         limit 6) t), '[]'::jsonb),
    'trending', coalesce((select jsonb_agg(q order by hits desc)
                          from (select q, hits from searches where found > 0 order by hits desc limit 5) t2), '[]'::jsonb),
    'matches', case when (select length(term) from q) < 2 then '[]'::jsonb else coalesce((
        select jsonb_agg(distinct m) from (
          (select p.title as m from products p join sellers s on s.id = p.seller_id, q
            where p.status = 'live' and s.status = 'active'
              and p.title ~* ('\m' || q.term) limit 5)
          union
          (select s.brand_name from sellers s, q
            where s.status = 'active' and s.brand_name ~* ('\m' || q.term) limit 3)
          union
          (select c.label from categories c, q where c.label ~* ('\m' || q.term) limit 3)
        ) u), '[]'::jsonb) end);
$$;
