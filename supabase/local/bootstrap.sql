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
-- 20260903230002_rls.sql fails to take it all away again, the tests must fail.

drop schema if exists auth cascade;
create schema auth;

-- Stands in for Supabase's GoTrue claim. The harness sets `request.jwt.uid`
-- per connection to impersonate a signed-in seller.
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(current_setting('request.jwt.uid', true), '')::uuid
$$;

-- Supabase's auth.jwt() is the whole JWT claim set. is_admin() reads the email
-- out of it, so the harness has to be able to set one.
create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;

grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;

-- The permissive defaults, exactly as Supabase leaves them.
grant all on all tables    in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on all functions in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables    to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;

-- ---------------------------------------------------------------- storage ---
-- Enough of Supabase Storage to let 20260904070002_storage.sql apply and its
-- policies be exercised. Only the pieces the policies actually touch:
-- storage.objects, and foldername(), which returns the path segments WITHOUT
-- the filename — that is what makes `(storage.foldername(name))[1]` the owning
-- seller's id.
create schema if not exists storage;

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name      text not null,
  owner     uuid,
  metadata  jsonb default '{}'::jsonb
);

create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
  select (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1]
$$;

alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
-- Permissive to start with, exactly like the public schema above, so the
-- policies have to be what actually restricts anything.
grant all on storage.objects to anon, authenticated;
grant execute on function storage.foldername(text) to anon, authenticated;
