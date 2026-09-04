-- Messages between a buyer and a seller.
--
-- The hard part: buyers have no account, deliberately. So a thread is addressed
-- by the buyer's device id — the same random string that rate-limits reports —
-- and that id is effectively a bearer token: whoever holds it can read the
-- thread. It never leaves the device except in these calls, and a thread holds
-- questions about a listing, not anything worth stealing. If buyer accounts
-- ever arrive, threads move to a user id and this comment is the migration plan.

create table threads (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references sellers(id) on delete cascade,
  device_id   text not null,
  -- What it started about. Both optional: a thread can be about a listing, an
  -- order, or neither once the conversation moves on.
  product_id  uuid references products(id) on delete set null,
  order_code  text,
  buyer_name  text not null default 'Buyer',
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  seller_unread integer not null default 0,
  buyer_unread  integer not null default 0,
  -- One thread per buyer per shop. Splitting by listing means a seller answering
  -- three questions from one person sees three inboxes.
  unique (seller_id, device_id)
);
create index threads_seller on threads (seller_id, last_at desc);
create index threads_device on threads (device_id, last_at desc);

create table messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references threads(id) on delete cascade,
  sender     text not null check (sender in ('buyer', 'seller')),
  body       text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index messages_thread on messages (thread_id, created_at);

alter table threads  enable row level security;
alter table messages enable row level security;
-- No direct grants at all. Everything goes through the functions below, because
-- a buyer is identified by a string they send rather than by a session.

/* Buyer side. The device id is the credential, so every one of these takes it
   and scopes to it — there is no "list all threads". */
create or replace function public.buyer_open_thread(
  p_device text, p_seller uuid, p_product uuid default null,
  p_name text default null, p_body text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_recent int;
begin
  if coalesce(trim(p_device), '') = '' then
    raise exception 'no device' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from sellers where id = p_seller and status = 'active') then
    raise exception 'that shop is not open' using errcode = 'no_data_found';
  end if;

  -- A device sending hundreds of messages an hour is not asking about sizes.
  select count(*) into v_recent from messages m join threads t on t.id = m.thread_id
   where t.device_id = p_device and m.sender = 'buyer' and m.created_at > now() - interval '1 hour';
  if v_recent >= 40 then
    raise exception 'too many messages, try later' using errcode = 'check_violation';
  end if;

  insert into threads (seller_id, device_id, product_id, buyer_name)
  values (p_seller, p_device, p_product, coalesce(nullif(trim(p_name), ''), 'Buyer'))
  on conflict (seller_id, device_id) do update
    set product_id = coalesce(excluded.product_id, threads.product_id),
        buyer_name = case when threads.buyer_name = 'Buyer'
                          then excluded.buyer_name else threads.buyer_name end
  returning id into v_id;

  if coalesce(trim(p_body), '') <> '' then
    insert into messages (thread_id, sender, body) values (v_id, 'buyer', trim(p_body));
    update threads set last_at = now(), seller_unread = seller_unread + 1 where id = v_id;
  end if;

  return buyer_thread(p_device, v_id);
end $$;

create or replace function public.buyer_thread(p_device text, p_thread uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'seller_id', t.seller_id, 'seller', s.brand_name,
    'product_id', t.product_id,
    'product', (select p.title from products p where p.id = t.product_id),
    'last_at', t.last_at, 'unread', t.buyer_unread,
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender', m.sender, 'body', m.body, 'at', m.created_at) order by m.created_at)
      from messages m where m.thread_id = t.id), '[]'::jsonb))
  from threads t join sellers s on s.id = t.seller_id
  where t.id = p_thread and t.device_id = p_device;
$$;

create or replace function public.buyer_threads(p_device text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'seller', s.brand_name, 'seller_id', t.seller_id,
    'product', (select p.title from products p where p.id = t.product_id),
    'last_at', t.last_at, 'unread', t.buyer_unread,
    'preview', (select m.body from messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    'from', (select m.sender from messages m where m.thread_id = t.id order by m.created_at desc limit 1)
  ) order by t.last_at desc), '[]'::jsonb)
  from threads t join sellers s on s.id = t.seller_id
  where t.device_id = p_device;
$$;

create or replace function public.buyer_send(p_device text, p_thread uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from threads where id = p_thread and device_id = p_device) then
    raise exception 'not your conversation' using errcode = 'insufficient_privilege';
  end if;
  insert into messages (thread_id, sender, body) values (p_thread, 'buyer', trim(p_body));
  update threads set last_at = now(), seller_unread = seller_unread + 1 where id = p_thread;
  return buyer_thread(p_device, p_thread);
end $$;

create or replace function public.buyer_read(p_device text, p_thread uuid) returns void
language sql security definer set search_path = public as $$
  update threads set buyer_unread = 0 where id = p_thread and device_id = p_device;
$$;

/* Seller side, scoped on my_seller_id() as everything else is. */
create or replace function public.seller_threads() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v uuid := my_seller_id();
begin
  if v is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', t.id, 'buyer_name', t.buyer_name, 'order_code', t.order_code,
    'product', (select p.title from products p where p.id = t.product_id),
    'last_at', t.last_at, 'unread', t.seller_unread,
    'preview', (select m.body from messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    'from', (select m.sender from messages m where m.thread_id = t.id order by m.created_at desc limit 1)
  ) order by t.last_at desc) from threads t where t.seller_id = v), '[]'::jsonb);
end $$;

create or replace function public.seller_thread(p_thread uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'buyer_name', t.buyer_name,
    'product', (select p.title from products p where p.id = t.product_id),
    'product_id', t.product_id, 'unread', t.seller_unread,
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender', m.sender, 'body', m.body, 'at', m.created_at) order by m.created_at)
      from messages m where m.thread_id = t.id), '[]'::jsonb))
  from threads t where t.id = p_thread and t.seller_id = my_seller_id();
$$;

create or replace function public.seller_send(p_thread uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from threads where id = p_thread and seller_id = my_seller_id()) then
    raise exception 'not your conversation' using errcode = 'insufficient_privilege';
  end if;
  insert into messages (thread_id, sender, body) values (p_thread, 'seller', trim(p_body));
  update threads set last_at = now(), buyer_unread = buyer_unread + 1, seller_unread = 0
   where id = p_thread;
  return seller_thread(p_thread);
end $$;

create or replace function public.seller_read(p_thread uuid) returns void
language sql security definer set search_path = public as $$
  update threads set seller_unread = 0 where id = p_thread and seller_id = my_seller_id();
$$;

revoke all on function public.buyer_open_thread(text, uuid, uuid, text, text) from public;
revoke all on function public.buyer_thread(text, uuid)  from public;
revoke all on function public.buyer_threads(text)       from public;
revoke all on function public.buyer_send(text, uuid, text) from public;
revoke all on function public.buyer_read(text, uuid)    from public;
revoke all on function public.seller_threads()          from public;
revoke all on function public.seller_thread(uuid)       from public;
revoke all on function public.seller_send(uuid, text)   from public;
revoke all on function public.seller_read(uuid)         from public;

grant execute on function public.buyer_open_thread(text, uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.buyer_thread(text, uuid)  to anon, authenticated;
grant execute on function public.buyer_threads(text)       to anon, authenticated;
grant execute on function public.buyer_send(text, uuid, text) to anon, authenticated;
grant execute on function public.buyer_read(text, uuid)    to anon, authenticated;
grant execute on function public.seller_threads()          to authenticated;
grant execute on function public.seller_thread(uuid)       to authenticated;
grant execute on function public.seller_send(uuid, text)   to authenticated;
grant execute on function public.seller_read(uuid)         to authenticated;
