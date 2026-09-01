import test from "node:test";
import assert from "node:assert/strict";
import { projectEvents } from "../src/services/ledgerProjector.js";

test("projector applies supported events in sequence and advances checkpoint after commit", async () => {
  const calls = []; const client = { query: async (sql) => { calls.push(sql); } };
  const result = await projectEvents(client, [{ sequence_no: 2, event_type: "CashReserved", aggregate_id: "E1", payload: { amount: 5 } }, { sequence_no: 1, event_type: "OrderAccepted", aggregate_id: "E1", payload: {} }]);
  assert.deepEqual(result.map((r) => r.sequence), [1, 2]); assert.equal(calls.filter((q) => q === "COMMIT").length, 2);
});
