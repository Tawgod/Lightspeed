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
