import test from "node:test";
import assert from "node:assert/strict";
import { FourEyesApproval } from "../src/services/fourEyesApproval.js";

test("four-eyes rejects self approval and enforces same entity", () => {
  let now = 1000; const policy = new FourEyesApproval({ thresholds: { E1: 100 }, windowMs: 100, now: () => now });
  policy.submit({ orderId: "O1", entityId: "E1", notional: 101, submitterId: "U1" });
  assert.equal(policy.approve({ orderId: "O1", approverId: "U1", approverEntities: ["E1"] }).reason, "self_approval_forbidden");
  assert.equal(policy.approve({ orderId: "O1", approverId: "U2", approverEntities: ["E2"] }).reason, "entity_scope_mismatch");
});

test("four-eyes approval expires at the configured boundary", () => {
  let now = 1000; const policy = new FourEyesApproval({ thresholds: { E1: 100 }, windowMs: 100, now: () => now });
  policy.submit({ orderId: "O2", entityId: "E1", notional: 101, submitterId: "U1" }); now = 1100;
  assert.equal(policy.approve({ orderId: "O2", approverId: "U2", approverEntities: ["E1"] }).reason, "approval_window_expired");
});
