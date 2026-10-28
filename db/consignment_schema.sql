-- Consignment foundation schema. NOT automatically applied to production.
-- Explicit migrations, authorization, and integration testing required.
CREATE TABLE IF NOT EXISTS consignment_customers (
 id BIGSERIAL PRIMARY KEY,
 lightspeed_customer_id TEXT UNIQUE,
 display_name TEXT NOT NULL,
 email TEXT,
 phone TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS consignment_submissions (
 id BIGSERIAL PRIMARY KEY,
 public_reference TEXT UNIQUE NOT NULL,
 customer_id BIGINT NOT NULL REFERENCES consignment_customers(id),
 source TEXT NOT NULL CHECK (source IN ('online','staff','paper_import')),
 status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('DRAFT','SUBMITTED','PENDING_REVIEW','PARTIALLY_APPROVED','APPROVED','REJECTED')),
 submitted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS consignment_product_templates (
 id BIGSERIAL PRIMARY KEY,
 normalized_name TEXT NOT NULL,
 canonical_name TEXT NOT NULL,
 item_type TEXT NOT NULL,
 source_lightspeed_product_id TEXT,
 brand TEXT,
 descriptive_data JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(item_type, normalized_name, source_lightspeed_product_id)
);
CREATE INDEX IF NOT EXISTS consignment_template_match_idx ON consignment_product_templates (item_type, normalized_name);
CREATE TABLE IF NOT EXISTS consignment_items (
 id BIGSERIAL PRIMARY KEY,
 consignment_code TEXT UNIQUE NOT NULL,
 submission_id BIGINT NOT NULL REFERENCES consignment_submissions(id),
 template_id BIGINT REFERENCES consignment_product_templates(id),
 item_type TEXT NOT NULL,
 submitted_name TEXT NOT NULL,
 approved_name TEXT,
 asking_price NUMERIC(12,2) NOT NULL CHECK (asking_price >= 0),
 condition TEXT,
 inspection_data JSONB NOT NULL DEFAULT '{}'::jsonb,
 status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','REJECTED','APPROVED','FOR_SALE','SOLD_HOLD','CREDIT_DUE','CREDITED','RETURNED_TO_BUYER','RETURNED_TO_SELLER','CANCELLED')),
 lightspeed_product_id TEXT UNIQUE,
 lightspeed_product_active BOOLEAN,
 online_approved BOOLEAN NOT NULL DEFAULT FALSE,
 sale_id TEXT,
 sold_at TIMESTAMPTZ,
 credit_eligible_at TIMESTAMPTZ,
 credited_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((sold_at IS NULL) OR (credit_eligible_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS consignment_item_submission_idx ON consignment_items(submission_id);
CREATE INDEX IF NOT EXISTS consignment_item_status_idx ON consignment_items(status);
CREATE TABLE IF NOT EXISTS consignment_credit_ledger (
 id BIGSERIAL PRIMARY KEY,
 item_id BIGINT NOT NULL REFERENCES consignment_items(id),
 customer_id BIGINT NOT NULL REFERENCES consignment_customers(id),
 operation_key TEXT UNIQUE NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('ISSUE','REVERSE','ADJUST')),
 amount NUMERIC(12,2) NOT NULL,
 lightspeed_credit_reference TEXT,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','POSTED','FAILED','RECONCILIATION_REQUIRED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 posted_at TIMESTAMPTZ,
 UNIQUE(item_id,kind,operation_key)
);
CREATE TABLE IF NOT EXISTS consignment_item_events (
 id BIGSERIAL PRIMARY KEY,
 item_id BIGINT NOT NULL REFERENCES consignment_items(id),
 actor_kind TEXT NOT NULL,
 actor_reference TEXT,
 event_kind TEXT NOT NULL,
 details JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A fresh physical item is always a new consignment_items row and SKU.
-- A template can be reused for matching; an inactive sold SKU is never reactivated.
