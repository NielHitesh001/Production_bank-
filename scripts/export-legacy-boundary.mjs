import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readLegacyExport, readLedgerProjection, compareLegacyExport } from "../src/services/legacyParityAdapter.js";

const execFileAsync = promisify(execFile);
const exportPath = path.resolve(process.env.LEGACY_EXPORT_PATH || "FinanceVault/_system/exports/world-money-graph.v1.json");
const historyPath = path.resolve(process.env.PARITY_HISTORY_PATH || "FinanceVault/_system/parity/parity-runs.json");

async function triggerExport() {
  if (!process.env.LEGACY_EXPORT_COMMAND) return { triggered: false, reason: "external_export_mechanism_not_configured" };
  await execFileAsync(process.env.LEGACY_EXPORT_COMMAND, [], { shell: true, timeout: 120_000 });
  return { triggered: true };
}

const startedAt = Date.now();
const trigger = await triggerExport();
const legacy = await readLegacyExport(exportPath);
const ledger = await readLedgerProjection();
const result = legacy.state === "available" && ledger.state === "available"
  ? await compareLegacyExport({ filePath: exportPath, ledgerRecords: ledger.records, ledgerWatermark: ledger.watermark, now: Date.now() })
  : { state: "unavailable", eligible: false, reason: legacy.reason || ledger.reason };
const run = { runAt: new Date().toISOString(), durationMs: Date.now() - startedAt, trigger, exportRevision: legacy.revision || null, exportFileHash: legacy.fileHash || null, snapshotTimestamp: legacy.snapshotTimestamp || null, ledgerWatermark: ledger.watermark || null, sourceGapMs: result.sourceGapMs ?? null, eligible: result.eligible === true, resultState: result.state };
let history = []; try { history = JSON.parse(await fs.readFile(historyPath, "utf8")); } catch {}
history.push(run); await fs.mkdir(path.dirname(historyPath), { recursive: true }); await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
console.log(JSON.stringify(run));
