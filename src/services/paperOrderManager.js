import crypto from "node:crypto";

export class PaperOrderManager {
  constructor({ limit = 100000, threshold = 50000, audit = () => {} } = {}) { this.limit = limit; this.threshold = threshold; this.audit = audit; this.reserved = 0; this.orders = new Map(); this.killSwitch = false; this.version = 1; }
  engageKillSwitch(reason = "operator", actorId = "unknown", entityId = "global") { this.killSwitch = true; const event = { action: "KillSwitchEngaged", actorId, entityId, reason, timestamp: new Date().toISOString() }; this.audit(event); return { engaged: true, reason }; }
  clearKillSwitch() { this.killSwitch = false; }
  accept(command) {
    if (this.killSwitch) { const event = { action: "OrderDeniedKillSwitch", actorId: command?.actorId || "unknown", entityId: command?.entityId || "global", clientRequestId: command?.clientRequestId, timestamp: new Date().toISOString() }; this.audit(event); return { status: "rejected", reason: "kill_switch_active" }; }
    if (!command?.clientRequestId) return { status: "rejected", reason: "idempotency_key_required" };
    if (this.orders.has(command.clientRequestId)) return this.orders.get(command.clientRequestId);
    const amount = Number(command.notional || 0);
    if (!Number.isFinite(amount) || amount <= 0) return { status: "rejected", reason: "invalid_notional" };
    if (this.reserved + amount > this.limit) return { status: "rejected", reason: "limit_exceeded" };
    this.reserved += amount;
    const result = { status: "accepted", event: "OrderAccepted", orderId: crypto.randomUUID(), clientRequestId: command.clientRequestId, reservation: { event: "RiskReservationPlaced", amount, limit_snapshot_version: this.version }, executionState: "PAPER_PENDING" };
    this.orders.set(command.clientRequestId, result); return result;
  }
}

export const paperOrderManager = new PaperOrderManager();
