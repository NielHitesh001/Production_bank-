import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const databaseUrl = process.env.MONEYTRACE_TEST_DATABASE_URL;
test("Postgres paper-order unique constraint permits exactly one concurrent idempotent acceptance", { skip: !databaseUrl && "set MONEYTRACE_TEST_DATABASE_URL to run against PostgreSQL" }, async () => {
  const { Client } = await import("pg");
  const owner = new Client({ connectionString: databaseUrl }); await owner.connect();
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/002_append_event_procedure_and_roles.sql"), "utf8"));
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/003_paper_orders.sql"), "utf8"));
  await owner.query("ALTER ROLE wmt_app PASSWORD 'wmt_app_test'");
  const appUrl = new URL(databaseUrl); appUrl.username = "wmt_app"; appUrl.password = "wmt_app_test";
  const makeClient = async () => { const c = new Client({ connectionString: appUrl.toString() }); await c.connect(); return c; };
  const [a, b] = await Promise.all([makeClient(), makeClient()]);
  try {
    const insert = (c) => c.query("INSERT INTO paper_orders (client_request_id, actor_id, notional, status, limit_snapshot_version) VALUES ($1,$2,$3,'ACCEPTED',$4) ON CONFLICT (client_request_id) DO NOTHING RETURNING id", ["same-request", "analyst", 10, 1]);
    const results = await Promise.all([insert(a), insert(b)]);
    assert.equal(results.filter((r) => r.rows.length === 1).length, 1);
    const count = await a.query("SELECT count(*)::int AS count FROM paper_orders WHERE client_request_id = 'same-request'");
    assert.equal(count.rows[0].count, 1);
  } finally { await a.end(); await b.end(); await owner.end(); }
});
