CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  lightspeed_customer_id TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  discord_user_id TEXT,
  discord_handle TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  lightspeed_product_id TEXT UNIQUE,
  name TEXT NOT NULL,
  sku TEXT,
  upc TEXT,
  description TEXT,
  brand TEXT,
  product_category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_lightspeed_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (lower(sku));
CREATE INDEX IF NOT EXISTS idx_products_upc ON products (upc);
CREATE INDEX IF NOT EXISTS idx_products_name ON products (lower(name));

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  supplier_type TEXT,
  order_frequency TEXT,
  lightspeed_supplier_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sourcing_departments (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_sourcing_departments (
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sourcing_department_id BIGINT NOT NULL REFERENCES sourcing_departments(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  PRIMARY KEY (supplier_id, sourcing_department_id)
);

CREATE TABLE IF NOT EXISTS product_sourcing_departments (
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sourcing_department_id BIGINT NOT NULL REFERENCES sourcing_departments(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (product_id, sourcing_department_id)
);

CREATE TABLE IF NOT EXISTS supplier_products (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_sku TEXT,
  supply_price NUMERIC(12,2),
  priority INTEGER NOT NULL DEFAULT 1,
  is_orderable BOOLEAN NOT NULL DEFAULT true,
  availability_status TEXT,
  last_checked_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (supplier_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_products_supplier ON supplier_products (supplier_id, is_orderable);

CREATE TABLE IF NOT EXISTS special_orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES customers(id),
  source TEXT NOT NULL DEFAULT 'dashboard',
  legacy_source TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS special_order_items (
  id BIGSERIAL PRIMARY KEY,
  special_order_id BIGINT NOT NULL REFERENCES special_orders(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id),
  requested_name TEXT NOT NULL,
  requested_sku TEXT,
  requested_upc TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'OOS',
  preferred_supplier_id BIGINT REFERENCES suppliers(id),
  sourcing_department_id BIGINT REFERENCES sourcing_departments(id),
  release_date DATE,
  ordered_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  held_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  lightspeed_sale_id TEXT,
  notes TEXT,
  legacy_status TEXT,
  import_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_so_items_status ON special_order_items (status);
CREATE INDEX IF NOT EXISTS idx_so_items_ordered_at ON special_order_items (ordered_at);
CREATE INDEX IF NOT EXISTS idx_so_items_product ON special_order_items (product_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id BIGSERIAL PRIMARY KEY,
  special_order_item_id BIGINT NOT NULL REFERENCES special_order_items(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  note TEXT,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_status_history_item ON order_status_history (special_order_item_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS supplier_orders (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  lightspeed_consignment_id TEXT,
  supplier_order_number TEXT,
  ordered_at TIMESTAMPTZ,
  expected_at DATE,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_order_items (
  id BIGSERIAL PRIMARY KEY,
  supplier_order_id BIGINT NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  supplier_product_id BIGINT REFERENCES supplier_products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  quantity_received INTEGER NOT NULL DEFAULT 0,
  unit_cost NUMERIC(12,2),
  special_order_item_id BIGINT REFERENCES special_order_items(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_allocations (
  id BIGSERIAL PRIMARY KEY,
  special_order_item_id BIGINT NOT NULL REFERENCES special_order_items(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  lightspeed_sale_id TEXT,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  special_order_item_id BIGINT REFERENCES special_order_items(id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES customers(id),
  channel TEXT NOT NULL,
  recipient TEXT,
  external_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  message TEXT,
  error TEXT,
  suppression_reason TEXT,
  suppressed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications (status, channel);

CREATE TABLE IF NOT EXISTS special_order_import_runs (
  id BIGSERIAL PRIMARY KEY,
  file_name TEXT,
  source_hash TEXT UNIQUE,
  imported_by TEXT,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_one_ready_pending
ON notifications (special_order_item_id, channel)
WHERE status IN ('PENDING','QUEUED') AND channel='DISCORD_READY';

CREATE TABLE IF NOT EXISTS preorder_campaigns (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  game TEXT,
  supplier_id BIGINT REFERENCES suppliers(id),
  order_due_at TIMESTAMPTZ,
  release_date DATE,
  status TEXT NOT NULL DEFAULT 'OPEN',
  allocation_method TEXT NOT NULL DEFAULT 'QUEUE',
  pickup_window_days INTEGER NOT NULL DEFAULT 7,
  notes TEXT,
  source_sheet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preorder_products (
  id BIGSERIAL PRIMARY KEY,
  preorder_campaign_id BIGINT NOT NULL REFERENCES preorder_campaigns(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id),
  sku TEXT,
  upc TEXT,
  item_description TEXT NOT NULL,
  msrp NUMERIC(12,2),
  order_limit INTEGER,
  ordered_quantity INTEGER NOT NULL DEFAULT 0,
  received_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_floor_quantity INTEGER NOT NULL DEFAULT 0,
  release_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (preorder_campaign_id, sku)
);

CREATE TABLE IF NOT EXISTS preorder_requests (
  id BIGSERIAL PRIMARY KEY,
  preorder_product_id BIGINT NOT NULL REFERENCES preorder_products(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  requested_quantity INTEGER NOT NULL DEFAULT 1 CHECK (requested_quantity > 0),
  queue_position INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  notes TEXT,
  source_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_preorder_requests_product_queue
ON preorder_requests (preorder_product_id, queue_position, requested_at);

CREATE TABLE IF NOT EXISTS preorder_allocations (
  id BIGSERIAL PRIMARY KEY,
  preorder_request_id BIGINT NOT NULL REFERENCES preorder_requests(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'ALLOCATED',
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at TIMESTAMPTZ,
  pickup_deadline_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  notification_id BIGINT REFERENCES notifications(id),
  UNIQUE (preorder_request_id)
);

CREATE TABLE IF NOT EXISTS customer_pickup_events (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  preorder_request_id BIGINT REFERENCES preorder_requests(id) ON DELETE SET NULL,
  special_order_item_id BIGINT REFERENCES special_order_items(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_pickup_events_customer
ON customer_pickup_events (customer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS customer_purchase_metrics (
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  purchase_count INTEGER NOT NULL DEFAULT 0,
  gross_spend NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_purchase_at TIMESTAMPTZ,
  metadata JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, source)
);
CREATE INDEX IF NOT EXISTS idx_customer_purchase_metrics_source
ON customer_purchase_metrics (source, updated_at DESC);


ALTER TABLE supplier_orders
  ADD COLUMN IF NOT EXISTS lightspeed_sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

ALTER TABLE supplier_order_items
  ADD COLUMN IF NOT EXISTS special_order_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS floor_quantity INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS receiving_events (
  id BIGSERIAL PRIMARY KEY,
  supplier_order_id BIGINT REFERENCES supplier_orders(id) ON DELETE SET NULL,
  supplier_order_item_id BIGINT REFERENCES supplier_order_items(id) ON DELETE SET NULL,
  product_id BIGINT REFERENCES products(id),
  quantity_received INTEGER NOT NULL CHECK (quantity_received > 0),
  received_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE special_order_items
  ADD COLUMN IF NOT EXISTS supplier_needed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS crowdfunding_note TEXT;

CREATE TABLE IF NOT EXISTS special_order_item_suppliers (
  special_order_item_id BIGINT NOT NULL REFERENCES special_order_items(id) ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 1,
  availability_status TEXT,
  supplier_sku TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (special_order_item_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS idx_special_order_item_suppliers_supplier
ON special_order_item_suppliers (supplier_id, special_order_item_id);

ALTER TABLE supplier_products
  ADD COLUMN IF NOT EXISTS supplier_description TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer_text TEXT;

ALTER TABLE supplier_products
  ADD COLUMN IF NOT EXISTS order_channel TEXT NOT NULL DEFAULT 'TRADE',
  ADD COLUMN IF NOT EXISTS order_url TEXT;

ALTER TABLE special_order_items
  ADD COLUMN IF NOT EXISTS placeholder_product BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS product_data_status TEXT NOT NULL DEFAULT 'COMPLETE',
  ADD COLUMN IF NOT EXISTS source_url TEXT;

ALTER TABLE supplier_order_items
  ADD COLUMN IF NOT EXISTS placeholder_name TEXT,
  ADD COLUMN IF NOT EXISTS placeholder_sku TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE special_order_item_suppliers
  ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE TABLE IF NOT EXISTS product_identifiers (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  source TEXT,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_unique
ON product_identifiers (identifier_type, normalized_value, COALESCE(supplier_id,0));
CREATE INDEX IF NOT EXISTS idx_product_identifiers_value
ON product_identifiers (normalized_value);
CREATE INDEX IF NOT EXISTS idx_product_identifiers_product
ON product_identifiers (product_id);


ALTER TABLE products
  ADD COLUMN IF NOT EXISTS reorder_setup_needed BOOLEAN NOT NULL DEFAULT false;


ALTER TABLE products
  ADD COLUMN IF NOT EXISTS lightspeed_reconcile_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lightspeed_missing_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lightspeed_missing_since TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_products_reconcile
ON products (last_reconciled_at, lightspeed_reconcile_status);

CREATE TABLE IF NOT EXISTS product_reconcile_runs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  checked_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  flagged_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  protected_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


ALTER TABLE preorder_campaigns
  ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS source_form_url TEXT,
  ADD COLUMN IF NOT EXISTS source_email_message_id TEXT,
  ADD COLUMN IF NOT EXISTS external_submission_status TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN IF NOT EXISTS external_submission_reference TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_submit_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_submit_minutes_before INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS discord_published_at TIMESTAMPTZ;

ALTER TABLE preorder_products
  ADD COLUMN IF NOT EXISTS external_entry_id TEXT,
  ADD COLUMN IF NOT EXISTS store_order_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submitted_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS submitted_value NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS discord_notes TEXT;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS preorder_campaign_id BIGINT REFERENCES preorder_campaigns(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS preorder_request_id BIGINT REFERENCES preorder_requests(id) ON DELETE CASCADE;


CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_gw_staff_submission
ON notifications (preorder_campaign_id, channel)
WHERE preorder_campaign_id IS NOT NULL
  AND channel='DISCORD_GW_STAFF_SUBMITTED'
  AND status IN ('PENDING','QUEUED','SENT');

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_gw_customer_summary
ON notifications (preorder_campaign_id, customer_id, channel)
WHERE preorder_campaign_id IS NOT NULL
  AND customer_id IS NOT NULL
  AND channel='DISCORD_GW_ORDER_SUMMARY'
  AND status IN ('PENDING','QUEUED','SENT');
