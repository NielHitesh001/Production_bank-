import test from "node:test";
import assert from "node:assert/strict";
import { sealAuditArchive, verifyAuditArchive } from "../src/services/auditArchive.js";

test("audit archive seals and verifies an immutable manifest", () => {
  const archive = sealAuditArchive([{ sequence: 1, hash: "a" }, { sequence: 2, hash: "b" }]);
  assert.equal(verifyAuditArchive(archive).valid, true);
  archive.events[1].hash = "tampered";
  assert.equal(verifyAuditArchive(archive).reason, "content_hash_mismatch");
});

test("audit archive detects sequence gaps", () => {
  const archive = sealAuditArchive([{ sequence: 1 }, { sequence: 3 }]);
  assert.equal(verifyAuditArchive(archive).reason, "sequence_gap");
});
