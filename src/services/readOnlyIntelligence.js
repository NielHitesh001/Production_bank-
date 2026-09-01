/** Read-only Market Data and Analytics contracts for Checkpoint 3. */

export const ENTITLEMENT_VERSION = "market-read-v1";
export const MAX_QUERY_LIMIT = 500;
export const MAX_PATH_HOPS = 8;

export function validateEntitlement(snapshot, { subjectId, scope, now = Date.now() } = {}) {
  if (!snapshot || snapshot.version !== ENTITLEMENT_VERSION) return { allowed: false, reason: "missing_or_mismatched_version" };
  if (subjectId && snapshot.subjectId !== subjectId) return { allowed: false, reason: "subject_mismatch" };
  const expiresAt = Date.parse(snapshot.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { allowed: false, reason: "expired" };
  if (scope && (!Array.isArray(snapshot.scopes) || !snapshot.scopes.includes(scope))) return { allowed: false, reason: "scope_denied" };
  return { allowed: true };
}

export function freshnessState({ observedAt, watermarkAt, degraded = false, recovered = false, now = Date.now(), delayedAfterMs = 5_000, staleAfterMs = 60_000 } = {}) {
  if (degraded) return { state: "unavailable", feedState: "FeedDegraded", ageMs: null };
  const timestamp = Date.parse(watermarkAt || observedAt || "");
  if (!Number.isFinite(timestamp)) return { state: "unavailable", feedState: "FeedDegraded", ageMs: null };
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs > staleAfterMs) return { state: "stale", feedState: "FeedDegraded", ageMs };
  if (ageMs > delayedAfterMs) return { state: "delayed", feedState: "FeedHealthy", ageMs };
  return { state: "live", feedState: recovered ? "FeedRecovered" : "FeedHealthy", ageMs };
}

export function maskForRole(record, role = "Analyst") {
  const output = { ...record };
  if (role === "Admin" || role === "Investigator") return output;
  for (const field of ["accountNumber", "iban", "beneficialOwner", "counterpartyEmail", "pepDetails", "sanctionsEvidence"]) {
    if (field in output) delete output[field];
  }
  if (output.riskMetadata) output.riskMetadata = { ...output.riskMetadata, rationale: undefined };
  return output;
}

export function boundedLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_QUERY_LIMIT);
}

export function boundedHops(value, fallback = 3) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_PATH_HOPS);
}

export function buildResearchResult(rows, { limit, query, generatedAt = new Date().toISOString() } = {}) {
  const bounded = boundedLimit(limit);
  return { query: String(query || ""), limit: bounded, generatedAt, rows: (rows || []).slice(0, bounded) };
}
