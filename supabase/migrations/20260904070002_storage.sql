-- Product photographs.
--
-- Interim home: Supabase Storage. The plan is Cloudflare R2 — 10 GB free and,
-- far more importantly, no egress charge at all, which is the only thing that
-- makes 100k images affordable. R2 needs an interactive `wrangler login`, so
-- this ships on Storage now and the workspace keeps every object key in the
-- `photos` table. Moving later is a copy plus a rewrite of one base URL in
-- js/seller/storage.js.
--
-- Key layout: <seller_id>/<product_id>/<random>-<variant>.webp
--   * seller_id first, so a policy can check ownership from the path alone
--   * a RANDOM id, never a running number — positions change when photos are
--     reordered, and `1-card.webp` for a different photo overwrites one still
--     in use. That cost NovaCars a whole evening.

-- Reads are public: the bucket is a shopfront.
create policy "product photos are public"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-photos');

-- Writes are confined to the seller's own first path segment. A seller who
-- guesses another seller's id still fails, because my_seller_id() comes from
-- their JWT and not from anything they can type.
create policy "sellers write their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-photos'
    and (storage.foldername(name))[1] = public.my_seller_id()::text
  );

create policy "sellers replace their own files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'product-photos'
    and (storage.foldername(name))[1] = public.my_seller_id()::text
  );

-- Deletes matter more than they look: Storage has NO CASCADE, so removing a
-- product row leaves its files behind, and the orphans then collide with the
-- next upload. delete_product() returns the keys precisely so the workspace can
-- clear them here.
create policy "sellers delete their own files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-photos'
    and (storage.foldername(name))[1] = public.my_seller_id()::text
  );
