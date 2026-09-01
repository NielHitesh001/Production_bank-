import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const databaseUrl = process.env.MONEYTRACE_TEST_DATABASE_URL;

test("wmt_app can append audit events but cannot delete them", { skip: !databaseUrl && "set MONEYTRACE_TEST_DATABASE_URL to run against PostgreSQL" }, async () => {
  const { Client } = await import("pg");
  const migration = await fs.readFile(path.resolve("scripts/migrations/002_append_event_procedure_and_roles.sql"), "utf8");
  const owner = new Client({ connectionString: databaseUrl });
  await owner.connect();
  await owner.query(migration);
  await owner.query("ALTER ROLE wmt_app PASSWORD 'wmt_app_test' ");

  const appUrl = new URL(databaseUrl);
  appUrl.username = "wmt_app";
  appUrl.password = "wmt_app_test";
  const app = new Client({ connectionString: appUrl.toString() });
  await app.connect();
  try {
    await app.query("SELECT append_audit_event($1, $2, $3, $4, $5, $6, $7)", ["integration-test", "System", "test.append", "audit_event", "fixture", "11111111-1111-1111-1111-111111111111", { source: "integration" }]);
    await assert.rejects(() => app.query("DELETE FROM audit_events"), /permission denied/i);
    const first = await app.query("SELECT append_audit_event($1,$2,$3,$4,$5,$6,$7) AS chain_sequence", ["integration-test", "Analyst", "market_data.read", "read_model", "market", "22222222-2222-2222-2222-222222222222", { scope: "market:read" }]);
    const second = await app.query("SELECT append_audit_event($1,$2,$3,$4,$5,$6,$7) AS chain_sequence", ["integration-test", "Analyst", "research.query", "read_model", "research", "33333333-3333-3333-3333-333333333333", { scope: "research:read" }]);
    assert.equal(Number(second.rows[0].chain_sequence), Number(first.rows[0].chain_sequence) + 1, "read audit events must be contiguous in the append-only chain");
    const kill = await app.query("SELECT append_audit_event($1,$2,$3,$4,$5,$6,$7) AS chain_sequence", ["operator-1", "Admin", "KillSwitchEngaged", "risk_control", "entity-1", "44444444-4444-4444-4444-444444444444", { reason: "incident" }]);
    const denied = await app.query("SELECT append_audit_event($1,$2,$3,$4,$5,$6,$7) AS chain_sequence", ["analyst-1", "Analyst", "OrderDeniedKillSwitch", "order", "order-1", "55555555-5555-5555-5555-555555555555", { entityId: "entity-1" }]);
    assert.equal(Number(denied.rows[0].chain_sequence), Number(kill.rows[0].chain_sequence) + 1, "kill-switch events must remain contiguous in the append-only chain");
  } finally {
    await app.end();
    await owner.end();
  }
});
