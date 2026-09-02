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

test("Polygon REST poller fails closed without a server-side API key", async () => {
  const adapter = new PolygonMarketDataAdapter({ fetchImpl: undefined });
  adapter.setWatchlist([{ assetClass: "Equities", symbol: "SPY" }]);
  const status = await adapter.pollNext();
  assert.equal(status.state, MARKET_DATA_STATES.UNAVAILABLE);
  assert.equal(status.reason, "polygon_api_key_not_configured");
});

test("Polygon REST poller queues round-robin delayed aggregate reads", async () => {
  let now = Date.parse("2026-09-02T10:00:00.000Z");
  const requestedUrls = [];
  const adapter = new PolygonMarketDataAdapter({
    apiKey: "test-key",
    now: () => now,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return { ok: true, json: async () => ({ results: [{ o: 100, h: 102, l: 99, c: 101, v: 10, t: now - 1_000 }] }) };
    },
  });
  adapter.setWatchlist([{ assetClass: "Equities", symbol: "SPY" }, { assetClass: "Crypto", symbol: "BTC/USD" }]);
  const first = await adapter.pollNext();
  now += adapter.pollingIntervalMs;
  const second = await adapter.pollNext();
  assert.equal(adapter.pollingIntervalMs, 12_000);
  assert.equal(first.symbol, "SPY");
  assert.equal(second.symbol, "BTC/USD");
  assert.equal(first.freshness.state, MARKET_DATA_STATES.DELAYED);
  assert.match(requestedUrls[0], /SPY/);
  assert.match(requestedUrls[1], /X%3ABTC-USD/);
});

test("Polygon REST snapshot reports last known data with refresh scheduling metadata", async () => {
  const now = Date.parse("2026-09-02T10:00:00.000Z");
  const adapter = new PolygonMarketDataAdapter({
    apiKey: "test-key",
    now: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ o: 100, h: 102, l: 99, c: 101, v: 10, t: now - 1_000 }] }) }),
  });
  adapter.setWatchlist([{ assetClass: "Equities", symbol: "SPY" }]);
  await adapter.pollNext();
  const [ticker] = adapter.getSnapshot(now + 4_000);
  assert.equal(ticker.symbol, "SPY");
  assert.equal(ticker.freshness.state, MARKET_DATA_STATES.DELAYED);
  assert.equal(ticker.nextRefreshInMs, 8_000);
});
