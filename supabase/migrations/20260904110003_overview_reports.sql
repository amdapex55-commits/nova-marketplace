-- admin_overview() gains reports_open.
--
-- A separate file rather than an edit to 20260904110002, which had already been
-- applied. `supabase db push` tracks migrations by version and never re-runs
-- one, so editing an applied file changes the repo and nothing else — it says
-- "Remote database is up to date" and the change silently never ships. Once a
-- migration has been pushed it is history; corrections go in a new file.

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
    'reports_open',     (select count(*) from reports where status = 'open'),
    'orders_total',     (select count(*) from orders),
    'orders_today',     (select count(*) from orders where placed_at >= current_date),
    'gmv_total',        (select coalesce(sum(grand_total), 0) from orders),
    'gmv_today',        (select coalesce(sum(grand_total), 0) from orders where placed_at >= current_date),
    'parcels_open',     (select count(*) from shipments where status in ('placed','confirmed','dispatched')),
    'trials_ending',    (select count(*) from sellers
                          where plan = 'trial' and status = 'active'
                            and trial_ends_at < now() + interval '7 days')
  );
end $$;
