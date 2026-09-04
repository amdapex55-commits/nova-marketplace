-- Getting ready for more than a handful of rows.
--
-- Nothing here changes behaviour. It is the indexes the read paths actually
-- need, added now rather than after the first slow day — every one of them
-- matches a WHERE or ORDER BY that already exists in a function above.

-- The deck and browse both filter live products from active sellers and order
-- on promoted, then created_at. Without this, every deck page is a sequential
-- scan of the whole catalogue.
create index if not exists products_live_rank
  on products (promoted desc, created_at desc) where status = 'live';

-- product_json() asks for a product's photos on every single card.
create index if not exists photos_product_pos on photos (product_id, position);

-- The "has a photograph" existence check, which every read now performs.
create index if not exists photos_product on photos (product_id);

-- Variants are read per product on every card that has them.
create index if not exists variants_product_pos on variants (product_id, position);

-- Reviews are aggregated per product and per seller on every listing.
create index if not exists reviews_product_rating on reviews (product_id) include (rating);
create index if not exists reviews_seller_rating  on reviews (seller_id)  include (rating);

-- The seller's inbox and the buyer's order page both walk shipments by order.
create index if not exists shipments_order on shipments (order_id);
create index if not exists shipment_lines_shipment on shipment_lines (shipment_id);
create index if not exists shipment_lines_product  on shipment_lines (product_id);

-- Order history for an account, newest first.
create index if not exists orders_user_placed on orders (user_id, placed_at desc);

-- Insights aggregate stats for one seller over a date window.
create index if not exists product_stats_day on product_stats (day, product_id);

-- Messages: a thread's messages in order, and unread counts per side.
create index if not exists messages_thread_at on messages (thread_id, created_at);

-- Site metrics are read by metric over a window.
create index if not exists site_stats_metric_day on site_stats (metric, day);

-- Searches are ranked by hits.
create index if not exists searches_hits on searches (hits desc) where found > 0;

/* Statistics targets on the columns the planner keeps guessing wrong about —
   status has three values that matter and a very skewed distribution. */
alter table products alter column status set statistics 500;
alter table shipments alter column status set statistics 500;

analyze products;
analyze photos;
analyze shipments;
