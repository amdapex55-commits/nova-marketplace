-- Guarding the columns a seller owns the ROW of but must not own the VALUE of.
--
-- This is the third time the same shape of bug has appeared, so it is worth
-- naming plainly: **row-level security restricts which rows a role may write.
-- It says nothing about which columns.** A grant of UPDATE on a table is a
-- grant on every column of it, and a policy that scopes the rows does not
-- narrow that by one field.
--
-- 0004 fixed the first instance by revoking UPDATE on `shipments` outright.
-- That is the cleanest answer, but it is not available here: sellers legitimately
-- edit their listings all day, so `products` has to stay writable. The next best
-- thing is a trigger that puts the protected columns back the way it found them.
--
--   products.status    publish_product() refuses a listing with no photograph,
--                      no stock, or an unapproved shop. All of that was worth
--                      nothing while a seller could PATCH status='live'.
--   products.promoted  promotion is something we SELL. A seller setting it is
--                      helping themselves to the advertising revenue.
--   products.seller_id belt and braces; the policy's WITH CHECK already covers it.

-- SECURITY INVOKER — deliberately NOT definer. Inside a definer function
-- current_user is the function's OWNER, never the caller, so a definer trigger
-- would see the owner on every row and wave every seller through. As invoker it
-- sees `authenticated`, which is the whole point. is_admin() is definer in its
-- own right, so reading `admins` from here still works.
create or replace function public.guard_product_columns() returns trigger
  language plpgsql set search_path = public as $$
begin
  -- Only the two roles PostgREST ever runs as are policed. Everything that
  -- legitimately changes these columns — publish_product(), the admin RPCs,
  -- place_order() marking a sold-out listing — is SECURITY DEFINER and runs as
  -- the table owner, so it is not one of these and passes straight through.
  --
  -- Naming the API roles rather than testing for a superuser on purpose: a
  -- hardcoded `postgres` role does not exist on a local Homebrew Postgres, and
  -- pg_has_role() against a missing role raises rather than returning false —
  -- which turned every product update into an error.
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if is_admin() then return new; end if;

  new.status    := old.status;
  new.promoted  := old.promoted;
  new.seller_id := old.seller_id;
  return new;
end $$;

create trigger products_guard_columns
  before update on products
  for each row execute function public.guard_product_columns();
