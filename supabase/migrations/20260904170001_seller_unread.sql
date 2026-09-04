-- me() gains the unread message count, so the seller's Messages tab can carry a
-- badge without a second round trip on every render.
create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when s.id is null then null else jsonb_build_object(
    'id', s.id, 'brand_name', s.brand_name, 'city', s.city, 'status', s.status,
    'plan', s.plan, 'trial_ends_at', s.trial_ends_at, 'dispatch_days', s.dispatch_days,
    'owner_name', c.owner_name, 'phone', c.phone, 'address', c.address,
    'products', (select count(*) from products p where p.seller_id = s.id),
    'live_products', (select count(*) from products p where p.seller_id = s.id and p.status = 'live'),
    'open_orders', (select count(*) from shipments sh
                    where sh.seller_id = s.id and sh.status in ('placed','confirmed')),
    'unread_messages', (select coalesce(sum(t.seller_unread), 0) from threads t where t.seller_id = s.id)
  ) end
  from seller_contacts c join sellers s on s.id = c.seller_id
  where c.user_id = auth.uid();
$$;

/* Sellers set how long they take to hand a parcel over — it is the half of the
   delivery estimate only they know. */
create or replace function public.update_shopfront(
  p_brand text, p_city text, p_phone text, p_address text, p_dispatch_days int default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := my_seller_id();
begin
  if v_id is null then raise exception 'no shop' using errcode = 'insufficient_privilege'; end if;
  if p_phone !~ '^03[0-9]{9}$' then
    raise exception 'phone must be a Pakistani mobile number' using errcode = 'check_violation';
  end if;
  update sellers set brand_name = trim(p_brand), city = trim(p_city),
         dispatch_days = coalesce(greatest(0, least(14, p_dispatch_days)), dispatch_days)
   where id = v_id;
  update seller_contacts set phone = trim(p_phone), address = trim(p_address) where seller_id = v_id;
  return me();
end $$;

drop function if exists public.update_shopfront(text, text, text, text);
grant execute on function public.update_shopfront(text, text, text, text, int) to authenticated;
