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

const WS_ENDPOINTS = Object.freeze({
  Equities: "wss://socket.polygon.io/stocks",
  FX: "wss://socket.polygon.io/forex",
  Crypto: "wss://socket.polygon.io/crypto",
  Options: "wss://socket.polygon.io/options",
});

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
 * Server-side Polygon WebSocket connector. It is deliberately inert without
 * an API key and provides status events for unavailable/degraded UI states.
 */
export class PolygonMarketDataAdapter {
  constructor({ apiKey, declaredMode = "delayed", WebSocketImpl = globalThis.WebSocket, now = () => Date.now() } = {}) {
    this.apiKey = apiKey;
    this.declaredMode = declaredMode;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.socket = null;
    this.listeners = new Set();
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

  connect({ assetClass = "Equities", symbols = [] } = {}) {
    if (!this.apiKey) return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "polygon_api_key_not_configured");
    if (!this.WebSocketImpl) return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "websocket_runtime_unavailable");
    const endpoint = WS_ENDPOINTS[assetClass];
    if (!endpoint) return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "asset_class_not_supported_by_polygon_adapter");

    this.socket = new this.WebSocketImpl(endpoint);
    this.socket.addEventListener("open", () => {
      this.socket.send(JSON.stringify({ action: "auth", params: this.apiKey }));
      const prefix = assetClass === "FX" ? "CA" : assetClass === "Crypto" ? "XA" : "A";
      if (symbols.length) this.socket.send(JSON.stringify({ action: "subscribe", params: symbols.map((symbol) => `${prefix}.${symbol}`).join(",") }));
      this.setStatus(this.declaredMode === "live" ? MARKET_DATA_STATES.LIVE : MARKET_DATA_STATES.DELAYED, "connected");
    });
    this.socket.addEventListener("message", (event) => {
      const messages = JSON.parse(event.data);
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (!message?.ev || message.ev === "status") continue;
        this.emit({ type: "tick", tick: normalizePolygonMessage(message, { assetClass, declaredMode: this.declaredMode, now: this.now() }) });
      }
    });
    this.socket.addEventListener("error", () => this.setStatus(MARKET_DATA_STATES.DEGRADED, "socket_error"));
    this.socket.addEventListener("close", () => this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "socket_closed"));
    return this.status;
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
    return this.setStatus(MARKET_DATA_STATES.UNAVAILABLE, "disconnected_by_operator");
  }
}
