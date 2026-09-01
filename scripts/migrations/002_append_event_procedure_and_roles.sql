-- MoneyTrace audit append boundary.
-- Execute as the database owner during deployment, never as wmt_app.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('Analyst', 'Investigator', 'Admin', 'System')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE
);

REVOKE ALL ON audit_events FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wmt_app') THEN
    CREATE ROLE wmt_app NOINHERIT LOGIN;
  END IF;
END $$;

REVOKE ALL ON audit_events FROM wmt_app;
REVOKE ALL ON SEQUENCE audit_events_id_seq FROM wmt_app;

CREATE OR REPLACE FUNCTION append_audit_event(
  p_actor_id TEXT,
  p_actor_role TEXT,
  p_action TEXT,
  p_resource_type TEXT,
  p_resource_id TEXT,
  p_request_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_previous_hash TEXT;
  v_event_hash TEXT;
  v_id BIGINT;
BEGIN
  SELECT event_hash INTO v_previous_hash FROM public.audit_events ORDER BY id DESC LIMIT 1;
  v_previous_hash := COALESCE(v_previous_hash, repeat('0', 64));
  v_event_hash := encode(digest(concat_ws('|', v_previous_hash, p_actor_id, p_actor_role, p_action, p_resource_type, p_resource_id, p_request_id::text, p_payload::text), 'sha256'), 'hex');

  INSERT INTO public.audit_events (actor_id, actor_role, action, resource_type, resource_id, request_id, payload, previous_hash, event_hash)
  VALUES (p_actor_id, p_actor_role, p_action, p_resource_type, p_resource_id, p_request_id, p_payload, v_previous_hash, v_event_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION append_audit_event(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_audit_event(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB) TO wmt_app;
