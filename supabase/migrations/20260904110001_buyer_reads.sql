-- What the buyer app reads.
--
-- The storefront is anonymous, so all of this is callable by `anon` and every
-- one of these functions returns only `live` products from `active` sellers —
-- the same rule the RLS policies enforce, restated here because a SECURITY
-- DEFINER function does not go through them.

/* One product, shaped exactly as the buyer app renders it. Every read below
   goes through this so a field can never be present on one screen and missing
   on another. */
create or replace function public.product_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description,
    -- No currency column: prices are whole rupees throughout, and a second
    -- currency would change the order arithmetic, not just a label.
    'price', p.price, 'interest', p.interest,
    'tags', to_jsonb(p.tags), 'condition', p.condition, 'stock', p.stock,
    'city', p.city, 'status', p.status, 'promoted', p.promoted,
    'created_at', p.created_at, 'seller_id', p.seller_id,
    'seller', jsonb_build_object('id', s.id, 'brand_name', s.brand_name,
                                 'city', s.city, 'rating', s.rating),
    -- Object KEYS, not URLs. The client appends the variant it wants, so moving
    -- the bucket to R2 later changes one base URL and nothing else.
    'photo_keys', coalesce((select jsonb_agg(ph.key order by ph.position)
                            from photos ph where ph.product_id = p.id), '[]'::jsonb)
  )
  from products p join sellers s on s.id = p.seller_id
  where p.id = p_id and p.status = 'live' and s.status = 'active';
$$;

/* The swipe deck.
 *
 * Ranking, never filtering, on interests: someone who taps only "Print" would
 * get a nine-card deck from a filter and would leave. Interest overlap is the
 * strongest term, promotion next — that is what sellers pay for — then
 * freshness, then a per-product jitter so the deck is not in the same order for
 * everyone.
 *
 * `p_seen` is the device's ledger, capped by the caller. The full ledger runs to
 * thousands of ids and shipping it on every request would cost more than the
 * page it fetches, so the client sends its most recent few hundred and filters
 * whatever slips through against its own copy. Belt and braces, cheap both ends.
 */
create or replace function public.deck(
  p_interests text[] default '{}',
  p_seen uuid[] default '{}',
  p_limit int default 24,
  p_offset int default 0
) returns jsonb
language sql stable security definer set search_path = public as $$
  with ranked as (
    select p.id,
           (case when p.interest = any(p_interests) then 3 else 0 end)
         + (case when p.promoted then 1.5 else 0 end)
         + greatest(0, 1 - extract(epoch from (now() - p.created_at)) / 7776000) * 1.2
         + (('x' || substr(md5(p.id::text), 1, 8))::bit(32)::bigint % 1000) / 1250.0
           as score
      from products p
      join sellers s on s.id = p.seller_id
     where p.status = 'live' and s.status = 'active' and p.stock > 0
       and not (p.id = any(p_seen))
       -- A listing with no photograph is a blank card, and the deck's entire
       -- value is that every card is worth looking at. publish_product()
       -- already refuses one, but an admin action or a direct insert does not,
       -- so the read enforces it too rather than trusting the write.
       and exists (select 1 from photos ph where ph.product_id = p.id)
  ), page as (
    select id from ranked order by score desc, id limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(product_json(p.id) order by r.score desc)
                       from page pg join products p on p.id = pg.id join ranked r on r.id = p.id), '[]'::jsonb),
    'remaining', greatest(0, (select count(*) from ranked) - p_offset - p_limit)
  );
$$;

create or replace function public.browse(
  p_interest text default null, p_limit int default 60, p_offset int default 0
) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(product_json(t.id) order by t.created_at desc) from (
        select p.id, p.created_at from products p join sellers s on s.id = p.seller_id
         where p.status = 'live' and s.status = 'active'
           and exists (select 1 from photos ph where ph.product_id = p.id)
           and (p_interest is null or p.interest = p_interest)
         order by p.promoted desc, p.created_at desc
         limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) t), '[]'::jsonb),
    'total', (select count(*) from products p join sellers s on s.id = p.seller_id
               where p.status = 'live' and s.status = 'active'
                 and exists (select 1 from photos ph where ph.product_id = p.id)
                 and (p_interest is null or p.interest = p_interest))
  );
$$;

/* Search.
 *
 * Full-text first, then trigram similarity for the typos — `kurta` typed as
 * `kurat` still has to find something. Deliberately not `ilike '%q%'`, which
 * cannot use an index and falls over the moment the catalogue is real. */
create or replace function public.search_products(p_q text, p_limit int default 60)
returns jsonb
language sql stable security definer set search_path = public as $$
  with q as (select websearch_to_tsquery('simple', coalesce(nullif(trim(p_q), ''), 'zzzznomatch')) as ts,
                    lower(trim(coalesce(p_q, ''))) as raw),
  hits as (
    select p.id,
           ts_rank(p.search, q.ts) * 4
         + word_similarity(q.raw, lower(p.title)) * 2
         + (case when lower(s.brand_name) like '%' || q.raw || '%' then 1.5 else 0 end)
         + (case when q.raw = any(select lower(unnest(p.tags))) then 1 else 0 end) as score
      from products p join sellers s on s.id = p.seller_id, q
     where p.status = 'live' and s.status = 'active'
       and (p.search @@ q.ts
            -- word_similarity, not similarity: the latter compares the query
            -- against the WHOLE title and is punished by length, so "kurat"
            -- against "Chikankari Kurta" scores far too low to match. This
            -- scores it against the best-matching word instead, which is what
            -- a typo actually needs.
            or word_similarity(q.raw, lower(p.title)) >= 0.45
            or lower(s.brand_name) like '%' || q.raw || '%'
            or q.raw = any(select lower(unnest(p.tags))))
  )
  select jsonb_build_object('items', coalesce(
    (select jsonb_agg(product_json(h.id) order by h.score desc)
     from (select * from hits order by score desc limit greatest(1, least(p_limit, 100))) h), '[]'::jsonb));
$$;

create or replace function public.products_by_id(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public as $$
  -- Order preserved so a wishlist stays in the order things were saved.
  select coalesce(jsonb_agg(product_json(x.id) order by x.ord), '[]'::jsonb)
  from unnest(p_ids) with ordinality as x(id, ord)
  where product_json(x.id) is not null;
$$;

create or replace function public.storefront() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sellers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'rating', s.rating))
      from sellers s where s.status = 'active'), '[]'::jsonb),
    'live_products', (select count(*) from products p join sellers s on s.id = p.seller_id
                       where p.status = 'live' and s.status = 'active'));
$$;

revoke all on function public.deck(text[], uuid[], int, int) from public;
revoke all on function public.product_json(uuid)             from public;
revoke all on function public.browse(text, int, int)         from public;
revoke all on function public.search_products(text, int)     from public;
revoke all on function public.products_by_id(uuid[])         from public;
revoke all on function public.storefront()                   from public;

grant execute on function public.deck(text[], uuid[], int, int) to anon, authenticated;
grant execute on function public.product_json(uuid)             to anon, authenticated;
grant execute on function public.browse(text, int, int)         to anon, authenticated;
grant execute on function public.search_products(text, int)     to anon, authenticated;
grant execute on function public.products_by_id(uuid[])         to anon, authenticated;
grant execute on function public.storefront()                   to anon, authenticated;
