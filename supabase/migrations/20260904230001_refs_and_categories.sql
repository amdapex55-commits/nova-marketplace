-- A short customer reference, and a real category tree.

-- ------------------------------------------------------------------ ref ----
/* A four-digit reference a buyer can read out on the phone.
 *
 * Four digits is 9,000 numbers (1000–9999) and no more. That is a hard ceiling
 * on customers, not a soft one — at ~8,000 buyers this needs widening to five,
 * and `ref_exhausted()` below is what tells us before it becomes an outage
 * rather than after. Allocated randomly rather than sequentially so the count
 * of customers is not published on every order.
 */
alter table buyers add column ref text unique check (ref ~ '^[1-9][0-9]{3}$');

create or replace function public.next_ref() returns text
  language plpgsql volatile security definer set search_path = public as $$
declare candidate text; tries int := 0;
begin
  loop
    candidate := (1000 + floor(random() * 9000))::int::text;
    exit when not exists (select 1 from buyers where ref = candidate);
    tries := tries + 1;
    if tries > 400 then
      raise exception 'customer references are exhausted — widen to five digits'
        using errcode = 'check_violation';
    end if;
  end loop;
  return candidate;
end $$;

create or replace function public.ref_exhausted() returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'used', (select count(*) from buyers where ref is not null),
    'total', 9000,
    'pct', round(100.0 * (select count(*) from buyers where ref is not null) / 9000, 1));
$$;
grant execute on function public.ref_exhausted() to authenticated;

-- ----------------------------------------------------------- categories ----
/* A tree, in a table, so it can be edited without a deploy. Two levels: a
   group a buyer would name out loud, and the thing they actually search for. */
create table categories (
  slug     text primary key,
  label    text not null,
  parent   text references categories(slug) on delete cascade,
  position smallint not null default 0,
  emoji    text
);
alter table categories enable row level security;
grant select on categories to anon, authenticated;
create policy categories_are_public on categories for select to anon, authenticated using (true);

insert into categories (slug, label, parent, position, emoji) values
  ('clothing','Clothing',null,0,'👗'),
    ('womens','Women''s wear','clothing',0,null),
    ('mens','Men''s wear','clothing',1,null),
    ('unstitched','Unstitched fabric','clothing',2,null),
    ('kids-wear','Kids'' clothing','clothing',3,null),
    ('shoes','Shoes','clothing',4,null),
    ('bags','Bags & purses','clothing',5,null),
    ('jewellery','Jewellery','clothing',6,null),
    ('modest','Abayas & scarves','clothing',7,null),
  ('home','Home',null,1,'🏠'),
    ('bedding','Bedding','home',0,null),
    ('kitchen','Kitchen','home',1,null),
    ('decor','Decor','home',2,null),
    ('rugs','Rugs & textiles','home',3,null),
  ('beauty','Beauty',null,2,'✨'),
    ('skincare','Skincare','beauty',0,null),
    ('haircare','Hair','beauty',1,null),
    ('fragrance','Fragrance & attar','beauty',2,null),
    ('makeup','Makeup','beauty',3,null),
  ('food','Food',null,3,'🍯'),
    ('pantry','Pantry','food',0,null),
    ('tea','Tea & coffee','food',1,null),
    ('sweets','Sweets & bakery','food',2,null),
    ('dryfruit','Dry fruit & nuts','food',3,null),
  ('sports','Sport',null,4,'�badminton'),
    ('fitness','Fitness','sports',0,null),
    ('outdoors','Outdoors','sports',1,null),
    ('cricket','Cricket','sports',2,null),
    ('activewear','Activewear','sports',3,null),
  ('magazines','Print',null,5,'📓'),
    ('books','Books','magazines',0,null),
    ('zines','Zines & journals','magazines',1,null),
    ('stationery','Stationery','magazines',2,null),
    ('art','Art & prints','magazines',3,null),
  ('kids','Kids & baby',null,6,'🧸'),
    ('toys','Toys','kids',0,null),
    ('baby','Baby care','kids',1,null),
  ('tech','Tech',null,7,'🎧'),
    ('audio','Audio','tech',0,null),
    ('accessories','Phone accessories','tech',1,null);

update categories set emoji = '🏸' where slug = 'sports';

alter table products add column category text references categories(slug);
create index products_category on products (category) where status = 'live';

/* `interest` stays as the top-level group and is kept in step automatically, so
   every query written before categories existed keeps working. */
create or replace function public.sync_product_interest() returns trigger
  language plpgsql set search_path = public as $$
begin
  if new.category is not null then
    new.interest := coalesce((select coalesce(c.parent, c.slug) from categories c where c.slug = new.category), new.interest);
  end if;
  return new;
end $$;

create trigger products_sync_interest
  before insert or update of category on products
  for each row execute function public.sync_product_interest();

create or replace function public.category_tree() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', g.slug, 'label', g.label, 'emoji', g.emoji,
    'children', coalesce((select jsonb_agg(jsonb_build_object(
        'slug', c.slug, 'label', c.label,
        'live', (select count(*) from products p join sellers s on s.id = p.seller_id
                  where p.category = c.slug and p.status = 'live' and s.status = 'active')) order by c.position)
      from categories c where c.parent = g.slug), '[]'::jsonb),
    'live', (select count(*) from products p join sellers s on s.id = p.seller_id
              where p.interest = g.slug and p.status = 'live' and s.status = 'active')
  ) order by g.position), '[]'::jsonb)
  from categories g where g.parent is null;
$$;
grant execute on function public.category_tree() to anon, authenticated;
