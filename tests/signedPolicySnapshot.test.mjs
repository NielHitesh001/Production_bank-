import test from "node:test";
import assert from "node:assert/strict";
import { SignedPolicySnapshotCache } from "../src/services/signedPolicySnapshot.js";

const base = { version: 1, subjectId: "U1", scopes: ["order:submit"], limit: 100, expiresAt: "2099-01-01T00:00:00Z" };
test("limit-change invalidation forces a refreshed snapshot version", () => {
  const cache = new SignedPolicySnapshotCache(); cache.publish(base); assert.equal(cache.validate({ subjectId: "U1", scope: "order:submit" }).snapshot.limit, 100);
  cache.invalidate(2); assert.equal(cache.validate({ subjectId: "U1", scope: "order:submit" }).allowed, false);
  cache.publish({ ...base, version: 2, limit: 50 }); assert.equal(cache.validate({ subjectId: "U1", scope: "order:submit" }).snapshot.limit, 50);
});

test("stale, unsigned, and mismatched snapshots fail closed", () => {
  let now = 0; const cache = new SignedPolicySnapshotCache({ now: () => now });
  cache.publish({ ...base, expiresAt: "1970-01-01T00:00:00Z" }); assert.equal(cache.validate({ subjectId: "U1" }).reason, "expired");
  const unsigned = { ...base, version: 2 }; cache.snapshot = unsigned; cache.requiredVersion = 2; assert.equal(cache.validate({ subjectId: "U1" }).reason, "unsigned_or_tampered");
  cache.publish(base); assert.equal(cache.validate({ subjectId: "U2" }).reason, "subject_mismatch");
});
