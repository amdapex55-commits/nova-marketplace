-- Administration.
--
-- The gate is HERE, in Postgres, and nowhere else. Every function below refuses
-- anyone who is not in `admins`, regardless of what the client sends or which
-- screen they came from. The front end decides what to *draw*; it never decides
-- what is *allowed*. Anyone can read the JavaScript, so anything the JavaScript
-- alone enforced would be worth nothing.
--
-- Admins are keyed by email rather than user id so an admin can be added before
-- that person has ever signed in. No rows are seeded in this file — the repo is
-- public, and a committed list of admin addresses is a list of accounts worth
-- attacking. Seed through the SQL editor.

create table admins (
  email    text primary key,
  note     text not null default '',
  added_at timestamptz not null default now()
);

-- RLS on, and NO grant to anon or authenticated at all: the table is
-- unreachable through the API by anybody. is_admin() reads it as definer.
alter table admins enable row level security;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.require_admin() returns void
  language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
end $$;

grant execute on function public.is_admin()     to authenticated;
grant execute on function public.require_admin() to authenticated;

-- ------------------------------------------------------------- promotion ----
-- Sellers pay to have a listing pushed. Only an admin can set it, because it is
-- something we sell rather than something a seller can help themselves to.
alter table products add column promoted boolean not null default false;
create index products_promoted on products (promoted) where status = 'live' and promoted;

-- ------------------------------------------------------------- overview ------
create or replace function public.admin_overview() returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'sellers_pending',  (select count(*) from sellers where status = 'pending'),
    'sellers_active',   (select count(*) from sellers where status = 'active'),
    'sellers_suspended',(select count(*) from sellers where status = 'suspended'),
    'listings_live',    (select count(*) from products where status = 'live'),
    'listings_pending', (select count(*) from products where status = 'pending'),
    'orders_total',     (select count(*) from orders),
    'orders_today',     (select count(*) from orders where placed_at >= current_date),
    -- Gross value that moved through the marketplace. We never touch it — the
    -- sellers collect it — so it is a health number, not revenue.
    'gmv_total',        (select coalesce(sum(grand_total), 0) from orders),
    'gmv_today',        (select coalesce(sum(grand_total), 0) from orders where placed_at >= current_date),
    'parcels_open',     (select count(*) from shipments where status in ('placed','confirmed','dispatched')),
    'trials_ending',    (select count(*) from sellers
                          where plan = 'trial' and status = 'active'
                            and trial_ends_at < now() + interval '7 days')
  );
end $$;

-- -------------------------------------------------------------- sellers ------
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
      -- Pending first: it is the only row that is waiting on a decision.
      case s.status when 'pending' then 0 when 'active' then 1 else 2 end,
      s.created_at desc)
    from sellers s left join seller_contacts c on c.seller_id = s.id
    where p_status is null or s.status = p_status
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_set_seller_status(p_seller uuid, p_status text) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_status not in ('pending','active','suspended') then
    raise exception 'not a seller status' using errcode = 'check_violation';
  end if;
  update sellers set status = p_status where id = p_seller;
  if not found then raise exception 'no such seller' using errcode = 'no_data_found'; end if;

  -- Approving a shop releases everything the seller queued while they waited.
  -- Suspending pulls their listings out of the deck in the same motion: a shop
  -- that is off must not still be selling.
  if p_status = 'active' then
    update products set status = 'live'
     where seller_id = p_seller and status = 'pending' and stock > 0
       and exists (select 1 from photos ph where ph.product_id = products.id);
  elsif p_status = 'suspended' then
    update products set status = 'pending' where seller_id = p_seller and status = 'live';
  end if;

  return (select jsonb_build_object('id', id, 'status', status,
            'released', (select count(*) from products where seller_id = p_seller and status = 'live'))
          from sellers where id = p_seller);
end $$;

create or replace function public.admin_set_seller_plan(p_seller uuid, p_plan text, p_months int default 1) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_plan not in ('trial','monthly','lapsed') then
    raise exception 'not a plan' using errcode = 'check_violation';
  end if;
  -- There is no payment rail yet: money arrives by bank transfer or JazzCash
  -- and somebody marks it here. Paid time extends from whichever is later, so
  -- marking a payment early never shortens what they already had.
  update sellers
     set plan = p_plan,
         trial_ends_at = case when p_plan = 'monthly'
           then greatest(trial_ends_at, now()) + (p_months || ' months')::interval
           else trial_ends_at end
   where id = p_seller;
  if not found then raise exception 'no such seller' using errcode = 'no_data_found'; end if;
  return (select jsonb_build_object('id', id, 'plan', plan, 'paid_until', trial_ends_at)
          from sellers where id = p_seller);
end $$;

-- ------------------------------------------------------------- listings ------
create or replace function public.admin_listings(p_status text default null) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'title', p.title, 'price', p.price, 'stock', p.stock,
      'status', p.status, 'promoted', p.promoted, 'city', p.city,
      'interest', p.interest, 'created_at', p.created_at,
      'seller', s.brand_name, 'seller_id', s.id, 'seller_status', s.status,
      'photos', (select coalesce(jsonb_agg(ph.key order by ph.position), '[]'::jsonb)
                 from photos ph where ph.product_id = p.id)
    ) order by case p.status when 'pending' then 0 else 1 end, p.created_at desc)
    from products p join sellers s on s.id = p.seller_id
    where p_status is null or p.status = p_status
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_set_product_status(p_product uuid, p_status text) returns text
  language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_status not in ('draft','pending','live','removed') then
    raise exception 'not a listing status' using errcode = 'check_violation';
  end if;
  update products set status = p_status where id = p_product;
  if not found then raise exception 'no such listing' using errcode = 'no_data_found'; end if;
  return p_status;
end $$;

create or replace function public.admin_set_promoted(p_product uuid, p_promoted boolean) returns boolean
  language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update products set promoted = p_promoted where id = p_product;
  if not found then raise exception 'no such listing' using errcode = 'no_data_found'; end if;
  return p_promoted;
end $$;

-- --------------------------------------------------------------- orders ------
create or replace function public.admin_orders(p_limit int default 50) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', o.code, 'placed_at', o.placed_at, 'payment', o.payment,
      'total', o.grand_total, 'city', o.city, 'buyer', o.buyer_name, 'phone', o.buyer_phone,
      'parcels', (select jsonb_agg(jsonb_build_object(
                    'seller', s.brand_name, 'status', sh.status, 'total', sh.total) order by s.brand_name)
                  from shipments sh join sellers s on s.id = sh.seller_id where sh.order_id = o.id)
    ) order by o.placed_at desc)
    from (select * from orders order by placed_at desc limit greatest(1, least(p_limit, 200))) o
  ), '[]'::jsonb);
end $$;

revoke all on function public.admin_overview()                            from public;
revoke all on function public.admin_sellers(text)                         from public;
revoke all on function public.admin_set_seller_status(uuid, text)         from public;
revoke all on function public.admin_set_seller_plan(uuid, text, int)      from public;
revoke all on function public.admin_listings(text)                        from public;
revoke all on function public.admin_set_product_status(uuid, text)        from public;
revoke all on function public.admin_set_promoted(uuid, boolean)           from public;
revoke all on function public.admin_orders(int)                           from public;

grant execute on function public.admin_overview()                          to authenticated;
grant execute on function public.admin_sellers(text)                       to authenticated;
grant execute on function public.admin_set_seller_status(uuid, text)       to authenticated;
grant execute on function public.admin_set_seller_plan(uuid, text, int)    to authenticated;
grant execute on function public.admin_listings(text)                      to authenticated;
grant execute on function public.admin_set_product_status(uuid, text)      to authenticated;
grant execute on function public.admin_set_promoted(uuid, boolean)         to authenticated;
grant execute on function public.admin_orders(int)                         to authenticated;
