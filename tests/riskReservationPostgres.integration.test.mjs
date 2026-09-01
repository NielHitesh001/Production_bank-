import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const databaseUrl = process.env.MONEYTRACE_TEST_DATABASE_URL;
test("Postgres atomic reservation check allows exactly one distinct order against a shared limit", { skip: !databaseUrl && "set MONEYTRACE_TEST_DATABASE_URL to run against PostgreSQL" }, async () => {
  const { Client } = await import("pg");
  const owner = new Client({ connectionString: databaseUrl }); await owner.connect();
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/002_append_event_procedure_and_roles.sql"), "utf8"));
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/004_risk_reservations.sql"), "utf8"));
  await owner.query("ALTER ROLE wmt_app PASSWORD 'wmt_app_test'");
  await owner.query("INSERT INTO risk_limits(entity_id, limit_amount) VALUES ('entity-1', 100) ON CONFLICT (entity_id) DO UPDATE SET limit_amount=100, reserved_amount=0");
  const appUrl = new URL(databaseUrl); appUrl.username = "wmt_app"; appUrl.password = "wmt_app_test";
  const makeClient = async () => { const c = new Client({ connectionString: appUrl.toString() }); await c.connect(); return c; };
  const [a, b] = await Promise.all([makeClient(), makeClient()]);
  try {
    const reserve = (c, orderId) => c.query("WITH checked AS (UPDATE risk_limits SET reserved_amount = reserved_amount + $1, updated_at = clock_timestamp() WHERE entity_id = 'entity-1' AND reserved_amount + $1 <= limit_amount RETURNING snapshot_version) INSERT INTO risk_reservations(entity_id, order_id, amount, limit_snapshot_version) SELECT 'entity-1', $2, $1, snapshot_version FROM checked RETURNING reservation_id", [60, orderId]);
    const results = await Promise.all([reserve(a, "order-a"), reserve(b, "order-b")]);
    assert.equal(results.filter((r) => r.rows.length === 1).length, 1);
    const row = await a.query("SELECT reserved_amount FROM risk_limits WHERE entity_id = 'entity-1'");
    assert.equal(Number(row.rows[0].reserved_amount), 60);
  } finally { await a.end(); await b.end(); await owner.end(); }
});
