CREATE TABLE IF NOT EXISTS risk_limits (
  entity_id TEXT PRIMARY KEY,
  limit_amount NUMERIC(20,4) NOT NULL CHECK (limit_amount >= 0),
  reserved_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  snapshot_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS risk_reservations (
  reservation_id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES risk_limits(entity_id),
  order_id TEXT NOT NULL UNIQUE,
  amount NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  limit_snapshot_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON risk_limits, risk_reservations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON risk_limits, risk_reservations TO wmt_app;
GRANT USAGE, SELECT ON SEQUENCE risk_reservations_reservation_id_seq TO wmt_app;
