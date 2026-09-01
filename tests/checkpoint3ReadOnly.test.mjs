import test from "node:test";
import assert from "node:assert/strict";
import { validateEntitlement, freshnessState, maskForRole, boundedLimit, buildResearchResult, ENTITLEMENT_VERSION } from "../src/services/readOnlyIntelligence.js";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

test("entitlement snapshot is versioned, scoped, and fail-closed", () => {
  const snapshot = { version: ENTITLEMENT_VERSION, subjectId: "analyst-1", scopes: ["market:read"], expiresAt: "2026-09-01T01:00:00.000Z" };
  assert.equal(validateEntitlement(snapshot, { subjectId: "analyst-1", scope: "market:read", now: NOW }).allowed, true);
  assert.equal(validateEntitlement(snapshot, { subjectId: "analyst-1", scope: "research:read", now: NOW }).allowed, false);
  assert.equal(validateEntitlement({ ...snapshot, version: "old" }, { subjectId: "analyst-1", scope: "market:read", now: NOW }).allowed, false);
  assert.equal(validateEntitlement({ ...snapshot, expiresAt: "2026-08-31T23:59:59.000Z" }, { subjectId: "analyst-1", scope: "market:read", now: NOW }).allowed, false);
});

test("freshness derives from server watermark and models degraded/stale states", () => {
  assert.equal(freshnessState({ watermarkAt: "2026-09-01T00:00:00.000Z", now: NOW }).state, "live");
  assert.equal(freshnessState({ watermarkAt: "2026-08-31T23:59:50.000Z", now: NOW }).state, "delayed");
  assert.equal(freshnessState({ watermarkAt: "2026-08-31T23:58:00.000Z", now: NOW }).state, "stale");
  assert.equal(freshnessState({ watermarkAt: "2026-09-01T00:00:00.000Z", recovered: true, now: NOW }).feedState, "FeedRecovered");
  assert.equal(freshnessState({ degraded: true, now: NOW }).feedState, "FeedDegraded");
  assert.equal(freshnessState({ now: NOW }).state, "unavailable");
});

test("analyst masking removes sensitive fields while privileged roles retain them", () => {
  const record = { id: "acct-1", iban: "DE123", accountNumber: "987", beneficialOwner: "hidden", riskMetadata: { score: 42, rationale: "pep" } };
  assert.equal(maskForRole(record, "Analyst").iban, undefined);
  assert.equal(maskForRole(record, "Investigator").iban, "DE123");
});

test("research query results are bounded", () => {
  assert.equal(boundedLimit(99999), 500);
  assert.equal(buildResearchResult([1, 2, 3], { limit: 2, query: "velocity" }).rows.length, 2);
});
