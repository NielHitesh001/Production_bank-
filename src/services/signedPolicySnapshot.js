import crypto from "node:crypto";

export class SignedPolicySnapshotCache {
  constructor({ secret = "dev-policy-secret", now = () => Date.now() } = {}) { this.secret = secret; this.now = now; this.snapshot = null; this.requiredVersion = null; }
  sign(payload) { return crypto.createHmac("sha256", this.secret).update(JSON.stringify(payload)).digest("hex"); }
  publish(payload) { const snapshot = { ...payload, signature: this.sign(payload) }; this.snapshot = snapshot; this.requiredVersion = payload.version; return snapshot; }
  invalidate(version) { this.requiredVersion = version; if (this.snapshot?.version !== version) this.snapshot = null; }
  validate({ subjectId, scope } = {}) {
    const s = this.snapshot;
    if (!s || this.requiredVersion !== s.version) return { allowed: false, reason: "missing_or_invalidated" };
    if (!s.signature) return { allowed: false, reason: "unsigned_or_tampered" };
    const { signature, ...payload } = s;
    if (signature !== this.sign(payload)) return { allowed: false, reason: "unsigned_or_tampered" };
    if (Date.parse(s.expiresAt || "") <= this.now()) return { allowed: false, reason: "expired" };
    if (subjectId && s.subjectId !== subjectId) return { allowed: false, reason: "subject_mismatch" };
    if (scope && !s.scopes?.includes(scope)) return { allowed: false, reason: "scope_denied" };
    return { allowed: true, snapshot: s };
  }
}
