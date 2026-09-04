-- Sizes, colours, sale prices and delivery estimates.
--
-- A kurta is not one thing. Until now a listing had one price and one stock
-- number, so a seller had to publish five listings for five sizes and keep the
-- stock in their head, and a buyer could not tell whether their size existed
-- without asking. That is the single biggest reason a clothing seller looks at
-- Nova and goes back to Instagram.

create table variants (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  size       text,
  colour     text,
  -- A swatch reads faster than a word, and "Indigo" means nothing on its own.
  colour_hex text check (colour_hex is null or colour_hex ~ '^#[0-9a-fA-F]{6}$'),
  stock      integer not null default 0 check (stock >= 0),
  position   smallint not null default 0,
  -- One row per combination. A seller who lists "M / Indigo" twice has made a
  -- mistake, and letting both exist means the deck shows a duplicate.
  unique (product_id, size, colour)
);
create index variants_product on variants (product_id);
create index variants_size on variants (size) where size is not null;

alter table variants enable row level security;
grant select on variants to anon, authenticated;
grant insert, update, delete on variants to authenticated;

create policy variants_of_live_products on variants
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = variants.product_id and p.status = 'live'));

create policy sellers_manage_own_variants on variants
  for all to authenticated
  using (exists (select 1 from products p where p.id = variants.product_id and p.seller_id = public.my_seller_id()))
  with check (exists (select 1 from products p where p.id = variants.product_id and p.seller_id = public.my_seller_id()));

/* Stock, once and for all.
   A listing either has variants — in which case the total is theirs — or it does
   not, in which case it is products.stock. Every other place that asks "is there
   any left" must call this, or the deck and the checkout will disagree. */
create or replace function public.available_stock(p_product uuid) returns integer
  language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from variants v where v.product_id = p_product)
      then (select coalesce(sum(v.stock), 0) from variants v where v.product_id = p_product)
    else (select stock from products where id = p_product)
  end;
$$;
grant execute on function public.available_stock(uuid) to anon, authenticated;

-- ------------------------------------------------------------- offers -------
-- A sale price rather than a percentage: the seller types what they want the
-- buyer to pay, and no rounding argument is possible.
alter table products add column sale_price integer
  check (sale_price is null or sale_price > 0);
alter table products add column sale_ends_at timestamptz;
alter table products add constraint sale_below_price
  check (sale_price is null or sale_price < price);

create index products_on_sale on products (sale_price)
  where status = 'live' and sale_price is not null;

/* The price actually charged, in one place, so the card, the bag, the checkout
   and place_order() can never quote different numbers. A sale that has run out
   is simply not a sale any more. */
create or replace function public.effective_price(p products) returns integer
  language sql immutable as $$
  select case
    when p.sale_price is not null
     and (p.sale_ends_at is null or p.sale_ends_at > now())
    then p.sale_price else p.price
  end;
$$;
grant execute on function public.effective_price(products) to anon, authenticated;

-- -------------------------------------------------- delivery estimates ------
-- How long this shop takes to hand a parcel to the courier. Transit is added on
-- top and depends on the cities; the buyer sees a range, never a promise.
alter table sellers add column dispatch_days smallint not null default 2
  check (dispatch_days between 0 and 14);

create or replace function public.delivery_estimate(
  p_seller_city text, p_buyer_city text, p_dispatch_days int, p_express boolean default false
) returns jsonb language sql immutable as $$
  select jsonb_build_object('min', lo, 'max', hi)
  from (select
    p_dispatch_days + (case when p_express then 1 else 2 end) as lo,
    p_dispatch_days + (case
      when lower(trim(coalesce(p_seller_city,''))) = lower(trim(coalesce(p_buyer_city,''))) then 2
      when p_express then 3 else 5 end) as hi) t;
$$;
grant execute on function public.delivery_estimate(text, text, int, boolean) to anon, authenticated;
