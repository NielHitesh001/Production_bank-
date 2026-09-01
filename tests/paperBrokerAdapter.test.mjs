import test from "node:test";
import assert from "node:assert/strict";
import { PaperBrokerAdapter } from "../src/services/paperBrokerAdapter.js";
import { LiveTradingGate } from "../src/services/liveTradingGate.js";

test("paper adapter evaluates closed gate and makes no transport call", async () => {
  const events = []; let calls = 0;
  const adapter = new PaperBrokerAdapter({ gate: new LiveTradingGate({ audit: (e) => events.push(e) }), transport: async () => { calls++; } });
  const result = await adapter.submit({ symbol: "EUR/USD" }, { mode: "paper" });
  assert.equal(result.status, "denied"); assert.equal(calls, 0); assert.equal(events[0].action, "LiveTradingGateEvaluated");
});

test("live-mode request is represented and denied by DENY_UNLESS_ALL", async () => {
  const adapter = new PaperBrokerAdapter(); const result = await adapter.submit({}, { mode: "live", chainVerified: true, killSwitchFresh: true, complianceSignedOff: true });
  assert.equal(result.status, "denied"); assert.equal(result.decision.policy, "DENY_UNLESS_ALL");
});

test("endpoint override is rejected before any transport can be reached", async () => {
  assert.throws(() => new PaperBrokerAdapter({ endpoint: "https://api.alpaca.markets" }), /fixed to the paper sandbox/);
});
