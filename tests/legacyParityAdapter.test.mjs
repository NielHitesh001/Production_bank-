import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compareLegacyExport, readLegacyExport } from "../src/services/legacyParityAdapter.js";

const realExport = path.resolve("FinanceVault/_system/exports/world-money-graph.v1.json");
test("reads the real FinanceVault export and preserves point-in-time metadata", async () => {
  const result = await readLegacyExport(realExport); assert.equal(result.state, "available"); assert.ok(result.snapshotTimestamp); assert.ok(result.fileHash); assert.ok(result.records.length > 0);
});
test("classifies injected drift and one-sided records", async () => {
  const base = await readLegacyExport(realExport); const records = base.records.slice(0, 2); records[0] = { ...records[0], name: "intentionally-drifted" }; records.push({ id: "ledger-only" });
  const result = await compareLegacyExport({ filePath: realExport, ledgerRecords: records, ledgerWatermark: "ledger-1", now: Date.parse(base.snapshotTimestamp) });
  assert.equal(result.state, "drifted"); assert.ok(result.differences.some((d) => d.state === "missing")); assert.equal(result.snapshotTimestamp, base.snapshotTimestamp); assert.equal(result.ledgerWatermark, "ledger-1");
});
test("missing and stale exports are unavailable and ineligible", async () => {
  assert.equal((await readLegacyExport("/tmp/does-not-exist.json")).state, "unavailable");
  const result = await compareLegacyExport({ filePath: realExport, now: Date.now() + 2_000_000 }); assert.equal(result.eligible, false); assert.equal(result.reason, "mirror_freshness_breach");
});
