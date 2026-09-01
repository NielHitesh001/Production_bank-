import test from "node:test";
import assert from "node:assert/strict";
import { PaperOrderManager } from "../src/services/paperOrderManager.js";

test("paper order acceptance is idempotent and reserves against a versioned limit", () => {
  const manager = new PaperOrderManager({ limit: 100 });
  const first = manager.accept({ clientRequestId: "req-1", notional: 80 });
  const second = manager.accept({ clientRequestId: "req-1", notional: 80 });
  assert.equal(first.event, "OrderAccepted"); assert.equal(second.orderId, first.orderId);
  assert.equal(first.reservation.limit_snapshot_version, 1);
  assert.equal(manager.accept({ clientRequestId: "req-2", notional: 30 }).reason, "limit_exceeded");
});

test("kill switch blocks an actual submission attempt", () => {
  const events = []; const manager = new PaperOrderManager({ audit: (event) => events.push({ ...event, chain_sequence: events.length + 1 }) }); manager.engageKillSwitch("incident", "U1", "E1");
  assert.equal(manager.accept({ clientRequestId: "blocked", notional: 1, actorId: "U2", entityId: "E1" }).reason, "kill_switch_active");
  assert.deepEqual(events.map((e) => e.action), ["KillSwitchEngaged", "OrderDeniedKillSwitch"]);
  assert.deepEqual(events.map((e) => e.chain_sequence), [1, 2]);
  assert.equal(events[0].actorId, "U1"); assert.equal(events[1].entityId, "E1");
});
