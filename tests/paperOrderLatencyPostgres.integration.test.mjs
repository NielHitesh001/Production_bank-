import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

const databaseUrl = process.env.MONEYTRACE_TEST_DATABASE_URL;
test("Postgres paper-order transaction latency under concurrent load", { skip: !databaseUrl && "set MONEYTRACE_TEST_DATABASE_URL to run against PostgreSQL" }, async () => {
  const { Client } = await import("pg");
  const owner = new Client({ connectionString: databaseUrl }); await owner.connect();
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/002_append_event_procedure_and_roles.sql"), "utf8"));
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/003_paper_orders.sql"), "utf8"));
  await owner.query(await fs.readFile(path.resolve("scripts/migrations/004_risk_reservations.sql"), "utf8"));
  await owner.query("ALTER ROLE wmt_app PASSWORD 'wmt_app_test'");
  await owner.query("INSERT INTO risk_limits(entity_id, limit_amount) VALUES ('latency-entity', 100000000) ON CONFLICT (entity_id) DO UPDATE SET limit_amount=100000000, reserved_amount=0");
  const appUrl = new URL(databaseUrl); appUrl.username = "wmt_app"; appUrl.password = "wmt_app_test";
  const clients = await Promise.all(Array.from({ length: 20 }, async () => { const c = new Client({ connectionString: appUrl.toString() }); await c.connect(); return c; }));
  const samples = []; let sequence = 0;
  const worker = async (client, workerId) => { for (let i = 0; i < 5; i++) { const orderId = `latency-${workerId}-${i}-${Date.now()}-${sequence++}`; const started = performance.now(); await client.query("BEGIN"); await client.query("WITH checked AS (UPDATE risk_limits SET reserved_amount = reserved_amount + 100 WHERE entity_id = 'latency-entity' AND reserved_amount + 100 <= limit_amount RETURNING snapshot_version) INSERT INTO risk_reservations(entity_id, order_id, amount, limit_snapshot_version) SELECT 'latency-entity', $1, 100, snapshot_version FROM checked", [orderId]); await client.query("INSERT INTO paper_orders (client_request_id, actor_id, notional, status, limit_snapshot_version) VALUES ($1,'latency-user',100,'ACCEPTED',1)", [orderId]); await client.query("SELECT append_audit_event($1,$2,$3,$4,$5,$6,$7)", ["latency-user", "Analyst", "OrderAccepted", "order", orderId, crypto.randomUUID(), { mode: "paper" }]); await client.query("COMMIT"); samples.push(performance.now() - started); } };
  try { await Promise.all(clients.map((c, i) => worker(c, i))); } finally { await Promise.all(clients.map((c) => c.end())); await owner.end(); }
  samples.sort((a, b) => a - b); const pct = (p) => samples[Math.ceil(samples.length * p) - 1];
  const p50 = pct(0.5); const p99 = pct(0.99); console.log(JSON.stringify({ samples: samples.length, concurrency: clients.length, p50Ms: Number(p50.toFixed(3)), p99Ms: Number(p99.toFixed(3)), riskBudgetMs: 75, acceptanceBudgetMs: 150 }));
  assert.equal(samples.length, 100); assert.ok(p99 < 150, `p99 ${p99}ms exceeded acceptance budget`);
});
