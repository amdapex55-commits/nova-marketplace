-- register_buyer hands out the four-digit reference.
create or replace function public.register_buyer(p_name text, p_email text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_phone text := trim(p_phone); v_ref text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if v_phone !~ '^03[0-9]{9}$' then
    raise exception 'enter a Pakistani mobile number, like 0300 1234567' using errcode = 'check_violation';
  end if;

  select ref into v_ref from buyers where user_id = auth.uid();
  if v_ref is null then v_ref := next_ref(); end if;

  insert into buyers (user_id, name, email, phone, ref)
  values (auth.uid(), trim(p_name), lower(trim(p_email)), v_phone, v_ref)
  on conflict (user_id) do update
    set name = excluded.name, email = excluded.email, phone = excluded.phone;

  update orders set user_id = auth.uid() where buyer_phone = v_phone and user_id is null;
  update threads set user_id = auth.uid()
   where user_id is null and device_id in (select device_id from threads t2 where t2.user_id = auth.uid());

  return me_buyer();
end $$;

create or replace function public.me_buyer() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when b.user_id is null then null else jsonb_build_object(
    'user_id', b.user_id, 'name', b.name, 'email', b.email, 'phone', b.phone,
    'ref', b.ref, 'since', b.created_at,
    'orders', (select count(*) from orders o where o.user_id = b.user_id)
  ) end
  from buyers b where b.user_id = auth.uid();
$$;
