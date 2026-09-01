/**
 * Checkpoint 4A reconciliation: projection-vs-source-ledger consistency.
 * External broker/legacy adapters intentionally remain an extension point.
 */
export const reconciliationStates = Object.freeze(["matched", "drifted", "missing", "unavailable"]);

export function createExternalSourceAdapter() {
  return { name: "external-source", fetch: async () => ({ state: "unavailable", reason: "adapter_not_configured" }) };
}

export function projectLedger(events = []) {
  const balances = new Map();
  for (const event of events) {
    const account = event.accountId || event.aggregateId;
    if (!account) continue;
    const delta = Number(event.amount ?? event.payload?.amount ?? 0);
    balances.set(account, (balances.get(account) || 0) + (Number.isFinite(delta) ? delta : 0));
  }
  return Object.fromEntries(balances);
}

export function reconcileProjection({ events, projection, watermark, checkpoint = 0, maxEvents = 10_000, emitAudit } = {}) {
  if (!Array.isArray(events) || !projection || !watermark) return { state: "unavailable", checkpoint, reason: "source_or_projection_unavailable" };
  const bounded = events.slice(checkpoint, checkpoint + Math.min(maxEvents, 10_000));
  const expected = projectLedger(bounded);
  const actual = projection.accountBalances || projection;
  const accounts = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences = [];
  for (const account of accounts) {
    const expectedValue = Number(expected[account] || 0);
    const actualValue = Number(actual[account] || 0);
    if (!(account in actual)) differences.push({ account, state: "missing", expected: expectedValue, actual: null });
    else if (expectedValue !== actualValue) differences.push({ account, state: "drifted", expected: expectedValue, actual: actualValue });
  }
  const state = differences.length ? "drifted" : "matched";
  const result = { state, differences, checkpoint: checkpoint + bounded.length, nextCheckpoint: checkpoint + bounded.length < events.length ? checkpoint + bounded.length : null, watermark, source: "ledger_event_store", reconciledAt: new Date().toISOString() };
  emitAudit?.({ action: `reconciliation.${state}`, payload: { watermark, checkpoint: result.checkpoint, differenceCount: differences.length } });
  return result;
}
