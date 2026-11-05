-- Strictly isolated test-only PIN setup. No actual employee data.
-- Row 1 can be completed once; reject replay and manual resets except audited staging maintenance.
CREATE TABLE IF NOT EXISTS hc_staging_pin_setup (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 pin_hash TEXT,
 completed_at TIMESTAMPTZ,
 CHECK ((pin_hash IS NULL AND completed_at IS NULL) OR
        (pin_hash ~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$' AND completed_at IS NOT NULL))
);
INSERT INTO hc_staging_pin_setup(id,pin_hash,completed_at) VALUES(1,NULL,NULL)
 ON CONFLICT (id) DO NOTHING;
