import test from "node:test";
import assert from "node:assert/strict";
import { MARKET_DATA_STATES, PolygonMarketDataAdapter, evaluateMarketFreshness, normalizePolygonMessage } from "../src/services/marketDataAdapter.js";

test("freshness never upgrades a delayed entitlement to live", () => {
  const now = Date.parse("2026-09-02T10:00:00.000Z");
  const delayed = evaluateMarketFreshness({ eventAt: "2026-09-02T09:59:59.000Z", receivedAt: "2026-09-02T10:00:00.000Z", declaredMode: "delayed", now });
  const live = evaluateMarketFreshness({ eventAt: "2026-09-02T09:59:59.000Z", receivedAt: "2026-09-02T10:00:00.000Z", declaredMode: "live", now });
  assert.equal(delayed.state, MARKET_DATA_STATES.DELAYED);
  assert.equal(delayed.eligibleForRealtime, false);
  assert.equal(live.state, MARKET_DATA_STATES.LIVE);
});

test("freshness detects missing provider data and stale transport", () => {
  const now = Date.parse("2026-09-02T10:00:00.000Z");
  assert.equal(evaluateMarketFreshness({ declaredMode: "live", now }).state, MARKET_DATA_STATES.UNAVAILABLE);
  assert.equal(evaluateMarketFreshness({ eventAt: "2026-09-02T09:00:00.000Z", receivedAt: "2026-09-02T09:00:00.000Z", declaredMode: "live", now }).state, MARKET_DATA_STATES.STALE);
});

test("Polygon aggregate messages normalize into terminal tick provenance", () => {
  const tick = normalizePolygonMessage({ ev: "CA", pair: "EUR/USD", o: 1.08, h: 1.10, l: 1.07, c: 1.09, v: 42, e: Date.parse("2026-09-02T09:59:59.000Z") }, {
    assetClass: "FX", declaredMode: "delayed", receivedAt: "2026-09-02T10:00:00.000Z", now: Date.parse("2026-09-02T10:00:00.000Z"),
  });
  assert.equal(tick.symbol, "EUR/USD");
  assert.equal(tick.provider, "polygon.io");
  assert.equal(tick.freshness.state, MARKET_DATA_STATES.DELAYED);
});

test("Polygon adapter fails closed without a server-side API key", () => {
  const adapter = new PolygonMarketDataAdapter({ WebSocketImpl: undefined });
  const status = adapter.connect({ assetClass: "Equities", symbols: ["SPY"] });
  assert.equal(status.state, MARKET_DATA_STATES.UNAVAILABLE);
  assert.equal(status.reason, "polygon_api_key_not_configured");
});
