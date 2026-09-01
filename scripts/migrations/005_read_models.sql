CREATE SCHEMA IF NOT EXISTS ledger;

CREATE TABLE IF NOT EXISTS ledger.account_balances_view (
  entity_id TEXT PRIMARY KEY,
  available_cash NUMERIC(20,4) NOT NULL DEFAULT 0,
  reserved_cash NUMERIC(20,4) NOT NULL DEFAULT 0,
  last_event_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ledger.positions_view (
  entity_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  quantity NUMERIC(30,10) NOT NULL DEFAULT 0,
  average_price NUMERIC(30,10),
  last_event_seq BIGINT NOT NULL DEFAULT 0,
  last_valuation_seq BIGINT,
  valuation_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (entity_id, instrument)
);

CREATE TABLE IF NOT EXISTS ledger.projector_checkpoints (
  projector_name TEXT PRIMARY KEY,
  last_event_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
