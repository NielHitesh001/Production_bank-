import crypto from "node:crypto";

export function sealAuditArchive(events = [], { schemaVersion = "audit-archive-v1", createdAt = new Date().toISOString() } = {}) {
  const body = JSON.stringify(events);
  const contentHash = crypto.createHash("sha256").update(body).digest("hex");
  return { manifest: { schemaVersion, createdAt, eventCount: events.length, firstSequence: events[0]?.sequence ?? null, lastSequence: events.at(-1)?.sequence ?? null, contentHash }, events };
}

export function verifyAuditArchive(archive) {
  if (!archive?.manifest || !Array.isArray(archive.events)) return { valid: false, reason: "malformed_archive" };
  const actual = crypto.createHash("sha256").update(JSON.stringify(archive.events)).digest("hex");
  if (actual !== archive.manifest.contentHash) return { valid: false, reason: "content_hash_mismatch" };
  for (let i = 1; i < archive.events.length; i++) if (archive.events[i].sequence !== archive.events[i - 1].sequence + 1) return { valid: false, reason: "sequence_gap" };
  return { valid: true, eventCount: archive.events.length, chainHead: archive.events.at(-1)?.hash || null };
}
