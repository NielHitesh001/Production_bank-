import test from "node:test";
import assert from "node:assert/strict";
import { reconcileProjection, createExternalSourceAdapter } from "../src/services/projectionReconciliation.js";

const events = [{ accountId: "A", amount: 10 }, { accountId: "A", amount: -3 }, { accountId: "B", amount: 4 }];
test("projection reconciliation reports matched state and resumable watermark checkpoint", () => {
  const result = reconcileProjection({ events, projection: { accountBalances: { A: 7, B: 4 } }, watermark: "evt-3" });
  assert.equal(result.state, "matched");
  assert.equal(result.checkpoint, 3);
  assert.equal(result.nextCheckpoint, null);
});

test("projection reconciliation reports drifted and missing accounts", () => {
  const result = reconcileProjection({ events, projection: { accountBalances: { A: 99 } }, watermark: "evt-3" });
  assert.equal(result.state, "drifted");
  assert.ok(result.differences.some((d) => d.state === "missing" && d.account === "B"));
  assert.ok(result.differences.some((d) => d.state === "drifted" && d.account === "A"));
});

test("external reconciliation adapter is explicit and unavailable until implemented", async () => {
  const result = await createExternalSourceAdapter().fetch();
  assert.equal(result.state, "unavailable");
});
