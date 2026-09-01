import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compareLegacyExport, readLegacyExport, readLedgerProjection } from "../src/services/legacyParityAdapter.js";

const realExport = path.resolve("FinanceVault/_system/exports/world-money-graph.v1.json");
test("reads the real FinanceVault export and preserves point-in-time metadata", async () => {
  const result = await readLegacyExport(realExport); assert.equal(result.state, "available"); assert.ok(result.snapshotTimestamp); assert.ok(result.fileHash); assert.ok(result.records.length > 0);
});
test("classifies injected drift and one-sided records", async () => {
  const base = await readLegacyExport(realExport); const records = base.records.slice(0, 2); records[0] = { ...records[0], name: "intentionally-drifted" }; records.push({ id: "ledger-only" });
  const result = await compareLegacyExport({ filePath: realExport, ledgerRecords: records, ledgerWatermark: base.snapshotTimestamp, now: Date.parse(base.snapshotTimestamp) });
  assert.equal(result.state, "drifted"); assert.ok(result.differences.some((d) => d.state === "missing")); assert.equal(result.snapshotTimestamp, base.snapshotTimestamp); assert.equal(result.ledgerWatermark, base.snapshotTimestamp);
});
test("missing and stale exports are unavailable and ineligible", async () => {
  assert.equal((await readLegacyExport("/tmp/does-not-exist.json")).state, "unavailable");
  const result = await compareLegacyExport({ filePath: realExport, now: Date.now() + 2_000_000 }); assert.equal(result.eligible, false); assert.equal(result.reason, "mirror_freshness_breach");
});
test("on-demand comparison consumes the real file-backed ledger projection", async () => {
  const legacy = await readLegacyExport(realExport); const ledger = await readLedgerProjection();
  assert.equal(ledger.state, "available"); assert.ok(ledger.records.length > 0); assert.ok(ledger.watermark);
  const result = await compareLegacyExport({ filePath: realExport, ledgerRecords: ledger.records, ledgerWatermark: ledger.watermark, now: Date.parse(legacy.snapshotTimestamp) });
  assert.equal(result.state, "unavailable"); assert.equal(result.reason, "mirror_freshness_breach"); assert.equal(result.eligible, false); assert.ok(result.sourceGapMs > 0); assert.ok(result.snapshotTimestamp); assert.equal(result.ledgerWatermark, ledger.watermark);
});
