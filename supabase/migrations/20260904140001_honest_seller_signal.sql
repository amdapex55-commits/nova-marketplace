-- Stop showing a rating nobody earned.
--
-- `sellers.rating` defaults to 5.0 and no code path has ever written to it, so
-- every product page has been telling buyers "Seller rating 5.0 / 5" about a
-- shop that has never sold anything. A fabricated trust signal is worse than no
-- signal: it is the exact thing a buyer would be angry to discover, on a
-- marketplace whose whole pitch is that we check the shops by hand.
--
-- Reviews are the right answer and are not built. Until they are, show
-- something that is true and that we can actually count.

alter table sellers drop column rating;

create or replace function public.product_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description,
    'price', p.price, 'interest', p.interest,
    'tags', to_jsonb(p.tags), 'condition', p.condition, 'stock', p.stock,
    'city', p.city, 'status', p.status, 'promoted', p.promoted,
    'created_at', p.created_at, 'seller_id', p.seller_id,
    'seller', jsonb_build_object(
      'id', s.id, 'brand_name', s.brand_name, 'city', s.city,
      'since', s.created_at,
      -- Countable, and true. "Delivered" rather than "orders" on purpose: an
      -- order that was refused at the door is not evidence of anything.
      'delivered', (select count(*) from shipments sh
                     where sh.seller_id = s.id and sh.status = 'delivered')),
    'photo_keys', coalesce((select jsonb_agg(ph.key order by ph.position)
                            from photos ph where ph.product_id = p.id), '[]'::jsonb)
  )
  from products p join sellers s on s.id = p.seller_id
  where p_id = p.id and p.status = 'live' and s.status = 'active';
$$;

create or replace function public.storefront() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sellers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'since', s.created_at))
      from sellers s where s.status = 'active'), '[]'::jsonb),
    'live_products', (select count(*) from products p join sellers s on s.id = p.seller_id
                       where p.status = 'live' and s.status = 'active'));
$$;

create or replace function public.admin_sellers(p_status text default null) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'status', s.status,
      'plan', s.plan, 'trial_ends_at', s.trial_ends_at, 'created_at', s.created_at,
      'owner_name', c.owner_name, 'phone', c.phone, 'address', c.address,
      'listings', (select count(*) from products p where p.seller_id = s.id),
      'live',     (select count(*) from products p where p.seller_id = s.id and p.status = 'live'),
      'parcels',  (select count(*) from shipments sh where sh.seller_id = s.id),
      'gmv',      (select coalesce(sum(sh.total), 0) from shipments sh where sh.seller_id = s.id)
    ) order by
      case s.status when 'pending' then 0 when 'active' then 1 else 2 end,
      s.created_at desc)
    from sellers s left join seller_contacts c on c.seller_id = s.id
    where p_status is null or s.status = p_status
  ), '[]'::jsonb);
end $$;
