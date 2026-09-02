import { normalizeMarketTick } from "./marketDataAggregator.js";

/**
 * Provider-neutral market-data boundary.
 *
 * Provider keys stay on the server. Frontend callers consume normalized ticks
 * and explicit provenance/freshness metadata only; a connected socket is never
 * presented as proof that data is real-time.
 */
export const MARKET_DATA_STATES = Object.freeze({
  LIVE: "live",
  DELAYED: "delayed",
  STALE: "stale",
  DEGRADED: "degraded",
  UNAVAILABLE: "unavailable",
  SIMULATED: "simulated",
});

const MODE_DELAYS_MS = Object.freeze({
  live: 0,
  delayed: 15 * 60 * 1000,
  eod: 24 * 60 * 60 * 1000,
  simulated: null,
});

const POLYGON_REST_BASE_URL = "https://api.polygon.io";

function toEpoch(value) {
  const epoch = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(epoch) ? epoch : null;
}

function normalizeDisplaySymbol(symbol, assetClass) {
  const raw = String(symbol || "").replace(/^[CX]:/, "");
  if (raw.includes("/") || raw.includes("-")) return raw.replace("-", "/");
  if ((assetClass === "FX" || assetClass === "Crypto") && raw.length >= 6) {
    return `${raw.slice(0, 3)}/${raw.slice(3, 6)}`;
  }
  return raw;
}

/**
 * Derives the UI state from provider-declared delivery mode and observed age.
 * `declaredMode` is authoritative: a delayed entitlement can never render live.
 */
export function evaluateMarketFreshness({
  eventAt,
  receivedAt = new Date().toISOString(),
  declaredMode = "live",
  providerHealthy = true,
  now = Date.now(),
  staleAfterMs = 30_000,
} = {}) {
  const eventEpoch = toEpoch(eventAt);
  const receivedEpoch = toEpoch(receivedAt);
  const sourceAgeMs = eventEpoch === null ? null : Math.max(0, now - eventEpoch);
  const transportAgeMs = receivedEpoch === null ? null : Math.max(0, now - receivedEpoch);
  const declaredDelayMs = MODE_DELAYS_MS[declaredMode] ?? null;

  if (declaredMode === "simulated") {
    return { state: MARKET_DATA_STATES.SIMULATED, sourceAgeMs, transportAgeMs, declaredDelayMs, eligibleForRealtime: false };
  }
  if (!providerHealthy || eventEpoch === null) {
    return { state: MARKET_DATA_STATES.UNAVAILABLE, sourceAgeMs, transportAgeMs, declaredDelayMs, eligibleForRealtime: false };
  }
  if (transportAgeMs !== null && transportAgeMs > staleAfterMs) {
    return { state: MARKET_DATA_STATES.STALE, sourceAgeMs, transportAgeMs, declaredDelayMs, eligibleForRealtime: false };
  }
  if (declaredMode !== "live") {
    return { state: MARKET_DATA_STATES.DELAYED, sourceAgeMs, transportAgeMs, declaredDelayMs, eligibleForRealtime: false };
  }
  return { state: MARKET_DATA_STATES.LIVE, sourceAgeMs, transportAgeMs, declaredDelayMs: 0, eligibleForRealtime: true };
}

export function normalizePolygonMessage(message, { assetClass = "Equities", declaredMode = "delayed", receivedAt = new Date().toISOString(), now = Date.now() } = {}) {
  const eventAt = message.e || message.t || message.s || receivedAt;
  const symbol = normalizeDisplaySymbol(message.sym || message.pair, assetClass);
  const last = Number(message.c ?? message.p ?? message.ap ?? message.bp ?? 0);
  const bid = Number(message.bp ?? last);
  const ask = Number(message.ap ?? last);
  const tick = normalizeMarketTick({
    symbol,
    name: symbol,
    assetClass,
    bid,
    ask: Math.max(ask, bid),
    last,
    open: Number(message.o ?? last),
    high: Number(message.h ?? last),
    low: Number(message.l ?? last),
    volume: Number(message.v ?? message.q ?? 0),
    timestamp: new Date(eventAt).toISOString(),
  }, "polygon.io");

  return {
    ...tick,
    eventAt: new Date(eventAt).toISOString(),
    receivedAt,
    provider: "polygon.io",
    deliveryMode: declaredMode,
    freshness: evaluateMarketFreshness({ eventAt, receivedAt, declaredMode, now }),
  };
}

/**
 * Server-side Polygon REST poller. It deliberately serializes requests and
 * defaults to five calls per minute so a free-plan integration cannot burst
 * past its declared allowance. WebSockets are intentionally not used here.
 */
export class PolygonMarketDataAdapter {
  constructor({
    apiKey,
    declaredMode = "delayed",
    maxCallsPerMinute = 5,
    baseUrl = POLYGON_REST_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {}) {
    this.apiKey = apiKey;
    this.declaredMode = declaredMode;
    this.maxCallsPerMinute = maxCallsPerMinute;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.listeners = new Set();
    this.watchlist = [];
    this.cursor = 0;
    this.pollTimer = null;
    this.pollInFlight = false;
    this.lastRequestAt = 0;
    this.status = { provider: "polygon.io", state: MARKET_DATA_STATES.UNAVAILABLE, reason: "not_connected", declaredMode };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener({ type: "status", status: this.status });
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.listeners.forEach((listener) => listener(event));
  }

  setStatus(state, reason) {
    this.status = { provider: "polygon.io", state, reason, declaredMode: this.declaredMode, updatedAt: new Date(this.now()).toISOString() };
    this.emit({ type: "status", status: this.status });
    return this.status;
  }

  setWatchlist(instruments) {
    const seen = new Set();
    this.watchlist = instruments.filter((instrument) => {
      const key = `${instrument.assetClass}:${instrument.symbol}`;
      if (!instrument.symbol || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.cursor = 0;
    return this.watchlist;
  }

  get pollingIntervalMs() {
    return Math.ceil(60_000 / Math.max(1, this.maxCallsPerMinute));
  }

  nextInstrument() {
    if (!this.watchlist.length) return null;
    const instrument = this.watchlist[this.cursor % this.watchlist.length];
    this.cursor = (this.cursor + 1) % this.watchlist.length;
    return instrument;
  }

  buildAggregateUrl({ symbol, assetClass = "Equities" }) {
    const polygonSymbol = assetClass === "FX" ? `C:${symbol.replace("/", "")}` : assetClass === "Crypto" ? `X:${symbol.replace("/", "-")}` : symbol;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(polygonSymbol)}/range/1/minute/${today}/${today}?adjusted=true&sort=desc&limit=1&apiKey=${encodeURIComponent(this.apiKey)}`;
  }

  normalizeAggregateResponse(payload, instrument) {
    const aggregate = payload?.results?.[0];
    if (!aggregate) return null;
    return normalizePolygonMessage({
      ev: "A",
      sym: instrument.symbol,
      o: aggregate.o,
      h: aggregate.h,
      l: aggregate.l,
      c: aggregate.c,
      v: aggregate.v,
      e: aggregate.t,
    }, {
      assetClass: instrument.assetClass,
      declaredMode: this.declaredMode,
      receivedAt: new Date(this.now()).toISOString(),
      now: this.now(),
    });
  }

  async pollNext() {
    if (!this.apiKey) return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "polygon_api_key_not_configured");
    if (!this.fetchImpl) return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "fetch_runtime_unavailable");
    const instrument = this.nextInstrument();
    if (!instrument) return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "watchlist_empty");
    if (this.pollInFlight) return this.status;
    this.pollInFlight = true;

    try {
      const response = await this.fetchImpl(this.buildAggregateUrl(instrument));
      if (!response.ok) return this.setStatus(MARKET_DATA_STATES.DEGRADED, `polygon_http_${response.status}`);
      const tick = this.normalizeAggregateResponse(await response.json(), instrument);
      if (!tick) return this.setStatus(MARKET_DATA_STATES.DEGRADED, "polygon_empty_aggregate_response");
      this.lastRequestAt = this.now();
      this.setStatus(MARKET_DATA_STATES.DELAYED, "rest_poll_ok");
      this.emit({ type: "tick", tick });
      return tick;
    } catch {
      return this.setStatus(MARKET_DATA_STATES.DEGRADED, "polygon_rest_request_failed");
    } finally {
      this.pollInFlight = false;
    }
  }

  startPolling() {
    if (this.pollTimer) return this.status;
    const poll = async () => {
      await this.pollNext();
      this.pollTimer = setTimeout(poll, this.pollingIntervalMs);
      this.pollTimer.unref?.();
    };
    poll();
    return this.status;
  }

  stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "polling_stopped_by_operator");
  }
}
