-- LOCAL TEST HARNESS ONLY — never applied to Supabase.
--
-- Its whole job is to make the local database behave like Supabase does BEFORE
-- our migrations run. NovaCars' local harness built `anon` from scratch on a
-- plain Postgres, where none of Supabase's defaults exist. That made the test
-- environment STRICTER than production, so a grant that did nothing in
-- production passed all twelve local assertions. A test environment that is
-- tighter than production is the worst way for a test to be wrong.
--
-- So this file deliberately hands anon and authenticated everything Supabase
-- would, including the default privileges for tables created later. If
-- 0002_rls.sql fails to take it all away again, the tests must fail.

drop schema if exists auth cascade;
create schema auth;

-- Stands in for Supabase's GoTrue claim. The harness sets `request.jwt.uid`
-- per connection to impersonate a signed-in seller.
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(current_setting('request.jwt.uid', true), '')::uuid
$$;

do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;

grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- The permissive defaults, exactly as Supabase leaves them.
grant all on all tables    in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on all functions in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables    to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
