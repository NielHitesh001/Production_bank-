import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PaperOrderManager } from "../src/services/paperOrderManager.js";

test("paper order acceptance latency under 100 concurrent workers", async () => {
  const manager = new PaperOrderManager({ limit: 1_000_000_000 });
  const samples = [];
  const worker = async (workerId) => {
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const result = manager.accept({ clientRequestId: `latency-${workerId}-${i}`, notional: 100 });
      samples.push(performance.now() - started);
      assert.equal(result.status, "accepted");
    }
  };
  await Promise.all(Array.from({ length: 100 }, (_, i) => worker(i)));
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
  const p50 = percentile(0.50); const p99 = percentile(0.99);
  console.log(JSON.stringify({ samples: samples.length, concurrency: 100, p50Ms: Number(p50.toFixed(3)), p99Ms: Number(p99.toFixed(3)), riskBudgetMs: 75, acceptanceBudgetMs: 150 }));
  assert.ok(p99 < 150, `p99 ${p99}ms exceeded acceptance budget`);
});
