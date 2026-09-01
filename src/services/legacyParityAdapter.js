import fs from "node:fs/promises";
import crypto from "node:crypto";
import { freshnessState } from "./readOnlyIntelligence.js";

export const LEGACY_MAX_AGE_MS = 15 * 60 * 1000 + 60 * 1000;

export async function readLegacyExport(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath, "utf8"); } catch { return { state: "unavailable", reason: "export_missing" }; }
  try {
    const document = JSON.parse(raw);
    if (!document || !document.generated_at || !Array.isArray(document.nodes)) return { state: "unavailable", reason: "export_malformed" };
    return { state: "available", revision: document.revision ?? document.generated_at, snapshotTimestamp: new Date(document.generated_at).toISOString(), fileHash: crypto.createHash("sha256").update(raw).digest("hex"), records: document.nodes.map((node) => ({ id: node.id, name: node.legal_name || node.name, jurisdiction: node.jurisdiction })) };
  } catch { return { state: "unavailable", reason: "export_malformed" }; }
}

export async function compareLegacyExport({ filePath, ledgerRecords = [], ledgerWatermark, now = Date.now(), emitAudit } = {}) {
  const legacy = await readLegacyExport(filePath);
  if (legacy.state !== "available") return legacy;
  const freshness = freshnessState({ watermarkAt: legacy.snapshotTimestamp, now, staleAfterMs: LEGACY_MAX_AGE_MS });
  if (freshness.state === "stale" || freshness.state === "unavailable") { emitAudit?.({ action: "MirrorFreshnessBreach", payload: { snapshotTimestamp: legacy.snapshotTimestamp, ageMs: freshness.ageMs } }); return { state: "unavailable", reason: "mirror_freshness_breach", eligible: false, snapshotTimestamp: legacy.snapshotTimestamp, ledgerWatermark }; }
  const left = new Map(legacy.records.map((r) => [r.id, r])); const right = new Map((ledgerRecords || []).map((r) => [r.id, r])); const differences = [];
  for (const [id, record] of left) if (!right.has(id)) differences.push({ id, state: "missing", source: "legacy" }); else if (JSON.stringify(record) !== JSON.stringify(right.get(id))) differences.push({ id, state: "drifted" });
  for (const id of right.keys()) if (!left.has(id)) differences.push({ id, state: "missing", source: "ledger" });
  const state = differences.length ? "drifted" : "matched";
  emitAudit?.({ action: state === "matched" ? "ParityClean" : "ParityBreak", payload: { revision: legacy.revision, snapshotTimestamp: legacy.snapshotTimestamp, ledgerWatermark, differenceCount: differences.length } });
  return { state, eligible: true, revision: legacy.revision, snapshotTimestamp: legacy.snapshotTimestamp, ledgerWatermark, differences };
}
