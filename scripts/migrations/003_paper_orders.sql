CREATE TABLE IF NOT EXISTS paper_orders (
  id BIGSERIAL PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  notional NUMERIC(20,4) NOT NULL CHECK (notional > 0),
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED','REJECTED')),
  limit_snapshot_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON paper_orders FROM PUBLIC;
GRANT SELECT, INSERT ON paper_orders TO wmt_app;
GRANT USAGE, SELECT ON SEQUENCE paper_orders_id_seq TO wmt_app;
