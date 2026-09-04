-- Nova Marketplace — schema.
--
-- One rule shapes this file: Nova never holds the money. Each seller ships
-- their own parcel and collects their own cash, so an ORDER is a buyer's
-- decision and a SHIPMENT is the thing that actually gets fulfilled and paid
-- for. Every total that matters lives on the shipment.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- sellers --
-- Split in two on purpose. Supabase pre-grants `anon` broad access to
-- everything in `public`, and a column-level GRANT only ADDS to that — so
-- "hide one column from the public" is not a thing that reliably works here.
-- The reliable version is two tables: what is public, and what is not.
create table sellers (
  id           uuid primary key default gen_random_uuid(),
  brand_name   text not null check (length(brand_name) between 2 and 80),
  city         text not null,
  rating       numeric(2,1) not null default 5.0 check (rating between 0 and 5),
  status       text not null default 'pending' check (status in ('pending','active','suspended')),
  plan         text not null default 'trial'   check (plan in ('trial','monthly','lapsed')),
  trial_ends_at timestamptz not null default now() + interval '30 days',
  created_at   timestamptz not null default now()
);

create table seller_contacts (
  seller_id  uuid primary key references sellers(id) on delete cascade,
  user_id    uuid not null unique,          -- auth.users.id
  owner_name text not null,
  phone      text not null,
  address    text not null
);

-- --------------------------------------------------------------- products --
create table products (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references sellers(id) on delete cascade,
  title       text not null check (length(title) between 3 and 120),
  description text not null default '',
  price       integer not null check (price > 0 and price <= 10000000),  -- whole rupees
  interest    text not null,
  tags        text[] not null default '{}',
  condition   text not null default 'New',
  stock       integer not null default 1 check (stock >= 0),
  city        text not null,
  status      text not null default 'pending'
              check (status in ('draft','pending','live','sold','removed')),
  created_at  timestamptz not null default now(),
  -- Full-text search, maintained by Postgres. Deliberately not `ilike '%q%'`,
  -- which cannot use an index and falls over the moment the catalogue is real.
  -- `tags` is deliberately NOT in here. array_to_string() is STABLE, not
  -- IMMUTABLE, so Postgres refuses it in a generated column; tags get their own
  -- array index below and the search function ORs the two together. The
  -- regconfig is cast explicitly for the same immutability reason.
  search tsvector generated always as (
    setweight(to_tsvector('simple'::regconfig, coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(city,'') || ' ' || coalesce(interest,'') || ' ' || coalesce(condition,'')), 'C')
  ) stored
);

create index products_search   on products using gin (search);
create index products_tags     on products using gin (tags);
create index products_title_trgm on products using gin (title gin_trgm_ops);  -- typo tolerance
create index products_live     on products (created_at desc) where status = 'live';
create index products_seller   on products (seller_id);

create table photos (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  position   smallint not null default 0,
  -- Object key in R2, never a running number: positions change when photos are
  -- reordered, and `1-full.webp` for a different photo overwrites one still in
  -- use. Storage has no cascade, so every delete path must clear these itself.
  key        text not null,
  width      integer,
  height     integer,
  unique (product_id, position)
);

-- ----------------------------------------------------------------- orders --
create table orders (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  placed_at     timestamptz not null default now(),
  buyer_name    text not null,
  buyer_phone   text not null check (buyer_phone ~ '^03[0-9]{9}$'),
  city          text not null,
  area          text not null,
  address       text not null,
  landmark      text not null default '',
  notes         text not null default '',
  express       boolean not null default false,
  payment       text not null check (payment in ('cod','transfer')),
  items_total    integer not null,
  delivery_total integer not null,
  grand_total    integer not null
);

create index orders_phone on orders (buyer_phone);

create table shipments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  seller_id   uuid not null references sellers(id),
  items_total integer not null,
  delivery    integer not null,
  total       integer not null,
  status      text not null default 'placed'
              check (status in ('placed','confirmed','dispatched','delivered','refused','cancelled')),
  -- Written down rather than assumed: whoever ships it, collects for it.
  collected_by text not null default 'seller' check (collected_by = 'seller'),
  unique (order_id, seller_id)
);

create index shipments_seller on shipments (seller_id, status);

create table shipment_lines (
  id          uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  product_id  uuid not null references products(id),
  -- Snapshots. The order must still read correctly after the seller edits the
  -- listing or takes it down.
  title       text not null,
  price       integer not null,
  qty         integer not null check (qty between 1 and 10)
);

-- ------------------------------------------------------------------ stats --
-- One row per product per day. Never one row per view: a 500 MB free-tier
-- database will not survive raw event logging, and the seller only ever sees
-- the daily number anyway.
create table product_stats (
  product_id   uuid not null references products(id) on delete cascade,
  day          date not null default current_date,
  impressions  integer not null default 0,
  keeps        integer not null default 0,
  detail_views integer not null default 0,
  adds         integer not null default 0,
  primary key (product_id, day)
);
