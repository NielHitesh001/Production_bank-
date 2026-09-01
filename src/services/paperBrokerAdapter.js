import { LiveTradingGate } from "./liveTradingGate.js";

const PAPER_ENDPOINT = "https://paper-api.alpaca.markets";
export class PaperBrokerAdapter {
  constructor({ endpoint, transport = async () => ({ status: "simulated" }), gate = new LiveTradingGate(), audit = () => {} } = {}) {
    if (endpoint && endpoint !== PAPER_ENDPOINT) throw new Error("broker endpoint is fixed to the paper sandbox");
    this.endpoint = PAPER_ENDPOINT; this.transport = transport; this.gate = gate; this.audit = audit;
  }
  async submit(order, context = {}) {
    const decision = this.gate.evaluate({ ...context, liveFlag: context.liveFlag === true });
    if (!decision.allowed) return { status: "denied", reason: "live_trading_gate", decision };
    if (context.mode !== "paper") return { status: "denied", reason: "paper_mode_required" };
    return this.transport({ endpoint: this.endpoint, order });
  }
}
