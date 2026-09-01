export class LiveTradingGate {
  constructor({ audit = () => {}, conditions = {} } = {}) { this.audit = audit; this.conditions = conditions; }
  evaluate(context = {}) {
    const checks = { chainVerified: Boolean(context.chainVerified), killSwitchFresh: Boolean(context.killSwitchFresh), complianceSignedOff: Boolean(context.complianceSignedOff), liveFlag: context.liveFlag === true };
    const allowed = Object.values(checks).every(Boolean);
    this.audit({ action: "LiveTradingGateEvaluated", allowed, checks, timestamp: new Date().toISOString() });
    return { allowed, policy: "DENY_UNLESS_ALL", checks };
  }
}
