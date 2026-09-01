export class FourEyesApproval {
  constructor({ thresholds = {}, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) { this.thresholds = new Map(Object.entries(thresholds)); this.windowMs = windowMs; this.now = now; this.orders = new Map(); }
  thresholdFor(entityId) { return Number(this.thresholds.get(entityId) ?? Infinity); }
  submit({ orderId, entityId, notional, submitterId }) {
    const required = Number(notional) > this.thresholdFor(entityId);
    const record = { orderId, entityId, notional: Number(notional), submitterId, required, status: required ? "PENDING_APPROVAL" : "APPROVED", expiresAt: required ? this.now() + this.windowMs : null };
    this.orders.set(orderId, record); return record;
  }
  approve({ orderId, approverId, approverEntities = [] }) {
    const record = this.orders.get(orderId);
    if (!record) return { approved: false, reason: "order_not_found" };
    if (!record.required) return { approved: true, reason: "approval_not_required" };
    if (record.submitterId === approverId) return { approved: false, reason: "self_approval_forbidden" };
    if (!approverEntities.includes(record.entityId)) return { approved: false, reason: "entity_scope_mismatch" };
    if (this.now() >= record.expiresAt) return { approved: false, reason: "approval_window_expired" };
    record.status = "APPROVED"; record.approverId = approverId; return { approved: true, orderId };
  }
}
