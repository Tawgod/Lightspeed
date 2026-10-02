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
